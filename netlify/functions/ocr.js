// Netlify serverless function to proxy OCR model API calls
// This keeps the API key secure on the server side

import crypto from 'crypto';
import fs from 'fs/promises';
import * as blobs from '@netlify/blobs';

import {
    getHeader,
    getAllowedOrigins,
    buildCorsHeaders,
    jsonResponse,
    getTokenSecret,
    verifyToken
} from './lib/shared.js';

const rateLimitMap = new Map();
const RATE_LIMIT_WINDOW_MS = 60000;
const RATE_LIMIT_MAX_REQUESTS_AUTHENTICATED = 50;
const RATE_LIMIT_MAX_ENTRIES = 5000;
const RATE_LIMIT_BLOB_STORE_NAME = 'ocr-rate-limit';
const RATE_LIMIT_RETRY_ATTEMPTS = 4;

function pruneRateLimitMap(now) {
    for (const [ip, record] of rateLimitMap.entries()) {
        if (!record || now - record.windowStart > RATE_LIMIT_WINDOW_MS) rateLimitMap.delete(ip);
    }
    if (rateLimitMap.size > RATE_LIMIT_MAX_ENTRIES) {
        const entries = Array.from(rateLimitMap.entries());
        entries.sort((a, b) => a[1].windowStart - b[1].windowStart);
        for (const [ip] of entries.slice(0, entries.length - RATE_LIMIT_MAX_ENTRIES)) rateLimitMap.delete(ip);
    }
}
const MAX_IMAGE_SIZE_BYTES = 5 * 1024 * 1024;
export const OCR_REQUEST_TIMEOUT_MS = 8000;
const DEFAULT_PRIMARY_PROVIDER = 'openrouter';
const DEFAULT_FALLBACK_PROVIDER = '';
const DEFAULT_HYPERBOLIC_OCR_MODELS = ['Qwen/Qwen2.5-VL-72B-Instruct','Qwen/Qwen2.5-VL-7B-Instruct'];
const DEFAULT_OPENROUTER_OCR_MODELS = ['google/gemini-2.5-flash-lite'];
let usageStore = null;
let usageStoreInitAttempted = false;
let usageStoreDisabledReason = null;

class OcrTimeoutError extends Error {
    constructor() { super('OCR request timed out'); this.name = 'OcrTimeoutError'; this.errorType = 'timeout'; }
}
function isOcrTimeoutError(error) { return !!(error && (error.errorType === 'timeout' || error.name === 'OcrTimeoutError')); }
function getRemainingRequestTime(deadlineAt) { return Math.max(0, deadlineAt - Date.now()); }

async function readResponseBodyWithinDeadline(response, controller, deadlineAt) {
    const remainingMs = getRemainingRequestTime(deadlineAt);
    if (remainingMs <= 0) throw new OcrTimeoutError();
    let timeoutId;
    const timeoutPromise = new Promise((_, reject) => {
        timeoutId = setTimeout(() => { try { controller.abort(); } catch (e) {} reject(new OcrTimeoutError()); }, remainingMs);
    });
    try { return await Promise.race([response.text(), timeoutPromise]); }
    finally { clearTimeout(timeoutId); }
}

function detectImageMime(base64Image) {
    const trimmed = String(base64Image || '').trim();
    if (!trimmed) return null;
    if (trimmed.startsWith('/9j/')) return 'image/jpeg';
    if (trimmed.startsWith('iVBORw0')) return 'image/png';
    return null;
}

function extractTextContent(content) {
    if (typeof content === 'string') return content;
    if (!content) return '';
    if (Array.isArray(content)) return content.map(part => !part ? '' : typeof part === 'string' ? part : typeof part.text === 'string' ? part.text : '').join('').trim();
    if (typeof content === 'object' && typeof content.text === 'string') return content.text;
    return '';
}

function isTruthy(value) {
    if (value === true) return true;
    return ['1','true','yes','on'].includes(String(value || '').trim().toLowerCase());
}

function sanitizeDebugMeta(meta) {
    if (!meta || typeof meta !== 'object') return null;
    const allowedKeys = ['attemptMode','attemptIndex','preprocess','thresholded','sourceW','sourceH','targetW','targetH','sharpness'];
    const out = {};
    for (const key of allowedKeys) {
        const value = meta[key];
        if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') out[key] = value;
    }
    return Object.keys(out).length ? out : null;
}

function buildOcrSuccessResponse(corsHeaders, partNumber, debugInfo, modelInfo, usageCounters) {
    const body = { partNumber };
    if (modelInfo) {
        body.providerUsed = modelInfo.providerUsed || null;
        body.providerFallbackUsed = !!modelInfo.providerFallbackUsed;
        body.modelUsed = modelInfo.modelUsed || null;
        body.modelFallbackUsed = !!modelInfo.modelFallbackUsed;
    }
    if (usageCounters) body.usageCounters = usageCounters;
    if (debugInfo) body.debug = debugInfo;
    return { statusCode: 200, headers: { ...corsHeaders, 'Content-Type':'application/json' }, body: JSON.stringify(body) };
}

function normalizeOpenRouterModelSlug(modelName) {
    const value = String(modelName || '').trim();
    if (!value) return '';
    const lower = value.toLowerCase();
    if (lower === 'mistralai/pixtral12b' || lower === 'mistralai/pixtral-12b-2409') return 'mistralai/pixtral-12b';
    return value;
}

function getProviderConfig(providerName) {
    const provider = String(providerName || '').trim().toLowerCase();
    if (provider === 'openrouter') {
        const apiKey = process.env.OPENROUTER_API_KEY || '';
        return {
            provider:'openrouter', label:'OpenRouter', endpoint:'https://openrouter.ai/api/v1/chat/completions', apiKey,
            getHeaders: () => {
                const headers = { 'Content-Type':'application/json', 'Authorization':`Bearer ${apiKey}` };
                if (process.env.OPENROUTER_HTTP_REFERER) headers['HTTP-Referer'] = process.env.OPENROUTER_HTTP_REFERER;
                else if (process.env.URL) headers['HTTP-Referer'] = process.env.URL;
                headers['X-Title'] = process.env.OPENROUTER_APP_NAME || 'instrumentskanner';
                return headers;
            }
        };
    }
    const apiKey = process.env.HYPERBOLIC_API_KEY || '';
    return { provider:'hyperbolic', label:'Hyperbolic', endpoint:'https://api.hyperbolic.xyz/v1/chat/completions', apiKey,
        getHeaders: () => ({ 'Content-Type':'application/json','Authorization':`Bearer ${apiKey}` }) };
}

function getProviderModelCandidates(providerName) {
    const provider = String(providerName || '').trim().toLowerCase();
    const envKey = provider === 'openrouter' ? 'OPENROUTER_OCR_MODELS' : 'HYPERBOLIC_OCR_MODELS';
    const defaults = provider === 'openrouter' ? DEFAULT_OPENROUTER_OCR_MODELS : DEFAULT_HYPERBOLIC_OCR_MODELS;
    const raw = process.env[envKey];
    if (!raw || !raw.trim()) return defaults.slice();
    const fromEnv = raw.split(',').map(m => {
        const trimmed = String(m || '').trim();
        if (!trimmed) return '';
        return provider === 'openrouter' ? normalizeOpenRouterModelSlug(trimmed) : trimmed;
    }).filter(Boolean);
    return fromEnv.length ? fromEnv : defaults.slice();
}

function getProviderChain() {
    const primary = String(process.env.OCR_PRIMARY_PROVIDER || DEFAULT_PRIMARY_PROVIDER).trim().toLowerCase();
    const fallback = String(process.env.OCR_FALLBACK_PROVIDER || DEFAULT_FALLBACK_PROVIDER).trim().toLowerCase();
    const chain = [];
    if (primary) chain.push(primary);
    if (fallback && fallback !== primary) chain.push(fallback);
    return chain;
}

function extractPartNumberFromRawText(rawText) {
    const rawUpper = String(rawText || '').toUpperCase().trim();
    if (!rawUpper || rawUpper === 'NO_PART_NUMBER' || rawUpper === '12345-6789') return '';
    const tokens = rawUpper.match(/[A-Z0-9.\-]+/g) || [];
    if (!tokens.some(t => t.length >= 4 && t.length <= 32 && /[0-9]/.test(t))) return '';
    return rawUpper;
}

function getCurrentMonthKey() { return new Date().toISOString().slice(0,7); }
function getUsageStore() {
    if (usageStore) return usageStore;
    if (usageStoreInitAttempted) return null;
    usageStoreInitAttempted = true;
    try {
        if (!blobs || typeof blobs.getStore !== 'function') { usageStoreDisabledReason='netlify_blobs_unavailable'; return null; }
        try { usageStore = blobs.getStore({ name:'ocr-usage' }); if (usageStore) return usageStore; } catch (e) {}
        const siteID = process.env.NETLIFY_SITE_ID || process.env.SITE_ID || '';
        const token = process.env.NETLIFY_BLOBS_TOKEN || process.env.NETLIFY_AUTH_TOKEN || process.env.NETLIFY_ACCESS_TOKEN || '';
        if (siteID && token) { usageStore = blobs.getStore({ name:'ocr-usage', siteID, token }); if (usageStore) return usageStore; }
        usageStoreDisabledReason='blobs_not_configured'; return null;
    } catch (e) { usageStoreDisabledReason=e?.message || 'blobs_init_failed'; return null; }
}

async function readJsonRecord(store,key) {
    if (!store || typeof store.getWithMetadata !== 'function') return {data:null,etag:null};
    try {
        const entry = await store.getWithMetadata(key,{type:'json'});
        if (!entry) return {data:null,etag:null};
        return {data: entry.data && typeof entry.data === 'object' ? entry.data : null, etag:entry.etag || null};
    } catch { return {data:null,etag:null}; }
}
async function writeJsonRecord(store,key,data,etag) {
    if (!store || typeof store.setJSON !== 'function') return false;
    const result = await store.setJSON(key,data,etag ? {onlyIfMatch:etag}:{onlyIfNew:true});
    return !!(result && result.modified);
}

async function recordMonthlyModelUsage(modelName) {
    const model = String(modelName || '').trim();
    if (!model) return null;
    try {
        const store = getUsageStore(); if (!store) return null;
        const month=getCurrentMonthKey(), key=`month:${month}`;
        for (let attempt=0; attempt<RATE_LIMIT_RETRY_ATTEMPTS; attempt++) {
            const snapshotRecord=await readJsonRecord(store,key);
            const snapshot=snapshotRecord.data || {};
            const byModel={...(snapshot.byModel || {})};
            byModel[model]=Number(byModel[model] || 0)+1;
            const next={month,total:Number(snapshot.total || 0)+1,byModel,updatedAt:new Date().toISOString()};
            if (await writeJsonRecord(store,key,next,snapshotRecord.etag)) return {month,total:next.total,model,modelCount:next.byModel[model]};
        }
        return null;
    } catch (e) { usageStore=null; usageStoreInitAttempted=true; usageStoreDisabledReason=e?.message || 'usage_counter_error'; return null; }
}

function getRateLimitStore() {
    try {
        if (!blobs || typeof blobs.getStore !== 'function') return null;
        try { return blobs.getStore({name:RATE_LIMIT_BLOB_STORE_NAME}); }
        catch {
            const siteID=process.env.NETLIFY_SITE_ID || process.env.SITE_ID || '';
            const token=process.env.NETLIFY_BLOBS_TOKEN || process.env.NETLIFY_AUTH_TOKEN || process.env.NETLIFY_ACCESS_TOKEN || '';
            return siteID && token ? blobs.getStore({name:RATE_LIMIT_BLOB_STORE_NAME,siteID,token}) : null;
        }
    } catch { return null; }
}
function getClientIp(headers) {
    const forwardedFor=getHeader(headers,'x-forwarded-for');
    if (forwardedFor && typeof forwardedFor==='string') { const first=forwardedFor.split(',')[0].trim(); if(first) return first; }
    const clientIp=getHeader(headers,'client-ip');
    return clientIp && String(clientIp).trim() ? String(clientIp).trim() : 'unknown';
}
function getRateLimitWindowKey(now=Date.now()) { return Math.floor(now/RATE_LIMIT_WINDOW_MS); }
function hashRateLimitKey(ip) { return crypto.createHash('sha256').update(String(ip || 'unknown')).digest('hex'); }
export function getRateLimitRecordKey(ip) { return `ip:${hashRateLimitKey(ip)}`; }
export function buildRateLimitRecord(snapshot={},now=Date.now()) {
    const windowStart=getRateLimitWindowKey(now)*RATE_LIMIT_WINDOW_MS;
    const currentCount=Number(snapshot.windowStart || 0)===windowStart ? Number(snapshot.count || 0):0;
    return {windowStart,count:currentCount+1,updatedAt:new Date(now).toISOString()};
}
async function isRateLimited(ip,isAuthenticated) {
    if (!isAuthenticated) return true;
    const now=Date.now(), store=getRateLimitStore();
    if (store) {
        const key=getRateLimitRecordKey(ip);
        for(let attempt=0; attempt<RATE_LIMIT_RETRY_ATTEMPTS; attempt++) {
            const snapshotRecord=await readJsonRecord(store,key), snapshot=snapshotRecord.data || {};
            const currentWindowStart=getRateLimitWindowKey(now)*RATE_LIMIT_WINDOW_MS;
            const currentCount=Number(snapshot.windowStart || 0)===currentWindowStart ? Number(snapshot.count || 0):0;
            if(currentCount>=RATE_LIMIT_MAX_REQUESTS_AUTHENTICATED) return true;
            if(await writeJsonRecord(store,key,buildRateLimitRecord(snapshot,now),snapshotRecord.etag)) return false;
        }
    }
    pruneRateLimitMap(now);
    const record=rateLimitMap.get(ip);
    if(!record || now-record.windowStart>RATE_LIMIT_WINDOW_MS){rateLimitMap.set(ip,{windowStart:now,count:1});return false;}
    if(record.count>=RATE_LIMIT_MAX_REQUESTS_AUTHENTICATED)return true;
    record.count++; return false;
}

export const handler = async (event) => {
    const requestDeadlineAt=Date.now()+OCR_REQUEST_TIMEOUT_MS;
    const allowedOrigins=getAllowedOrigins(), origin=getHeader(event.headers,'origin'), host=getHeader(event.headers,'host');
    const corsHeaders=buildCorsHeaders(origin,allowedOrigins,host);
    if(origin && !corsHeaders['Access-Control-Allow-Origin']) return jsonResponse({statusCode:403,corsHeaders,body:{error:'Origin not allowed'}});
    if(event.httpMethod==='OPTIONS') return {statusCode:200,headers:corsHeaders,body:''};
    const tokenSecret=getTokenSecret();
    if(!tokenSecret) return jsonResponse({statusCode:500,corsHeaders,body:{error:'Authentication is not configured',details:'Set AUTH_TOKEN_SECRET in your environment.'}});
    if(event.httpMethod!=='POST') return jsonResponse({statusCode:405,corsHeaders,body:{error:'Method not allowed'}});

    const authHeader=getHeader(event.headers,'authorization');
    let isAuthenticated=false;
    if(authHeader && authHeader.startsWith('Bearer ')) isAuthenticated=verifyToken(authHeader.substring(7),tokenSecret)!==null;
    const clientIp=getClientIp(event.headers);
    if(await isRateLimited(clientIp,isAuthenticated)) return jsonResponse({statusCode:isAuthenticated?429:401,corsHeaders,body:{error:isAuthenticated?'Too many requests. Please wait a moment.':'Authentication required. Please log in to use OCR.'}});

    const configuredProviders=getProviderChain().map(getProviderConfig).filter(Boolean).filter(cfg=>!!cfg.apiKey);
    if(!configuredProviders.length) return jsonResponse({statusCode:500,corsHeaders,body:{error:'No OCR provider API keys configured (need HYPERBOLIC_API_KEY and/or OPENROUTER_API_KEY)'}});

    try {
        const contentType=String(getHeader(event.headers,'content-type') || '').toLowerCase();
        if(!contentType.includes('application/json')) return jsonResponse({statusCode:415,corsHeaders,body:{error:'Unsupported Media Type. Use application/json.'}});
        let payload;
        try { payload=JSON.parse(event.body || ''); } catch { return jsonResponse({statusCode:400,corsHeaders,body:{error:'Invalid JSON body'}}); }
        const imageInput=payload?.image, debugRequested=!!(payload && isTruthy(payload.debug)), debugMeta=sanitizeDebugMeta(payload?.debugMeta);
        if(typeof imageInput!=='string' || !imageInput.trim()) return jsonResponse({statusCode:400,corsHeaders,body:{error:'No image provided'}});
        const base64Raw=imageInput.includes(',')?imageInput.split(',').pop():imageInput;
        const base64Image=String(base64Raw || '').trim().replace(/\s+/g,'');
        if(!base64Image || !/^[A-Za-z0-9+/=]+$/.test(base64Image)) return jsonResponse({statusCode:400,corsHeaders,body:{error:'Invalid base64 image data'}});
        const imageMime=detectImageMime(base64Image);
        if(!imageMime) return jsonResponse({statusCode:400,corsHeaders,body:{error:'Unsupported image format. Use JPEG or PNG.'}});
        const estimatedSize=(base64Image.length*3)/4, approxBytes=Math.floor(estimatedSize);
        let debugInfo=null;
        if(debugRequested){
            try{
                const imageBuffer=Buffer.from(base64Image,'base64');
                const sha256=crypto.createHash('sha256').update(imageBuffer).digest('hex');
                debugInfo={mime:imageMime,approxBytes,sha256,meta:debugMeta || undefined};
                if(isTruthy(process.env.OCR_DEBUG_WRITE_IMAGE)){
                    const extension=imageMime==='image/png'?'png':'jpg';
                    const filePath=`/tmp/ocr-${Date.now()}-${sha256.slice(0,12)}.${extension}`;
                    await fs.writeFile(filePath,imageBuffer); debugInfo.savedPath=filePath;
                }
            }catch(e){}
        }
        if(estimatedSize>MAX_IMAGE_SIZE_BYTES) return jsonResponse({statusCode:400,corsHeaders,body:{error:'Image too large. Maximum size is 5MB.'}});

        const modelAttempts=[];
        let deadlineExceeded=false,lastUpstreamStatus=null;
        const primaryProvider=configuredProviders[0]?.provider || null;
        const primaryModel=getProviderModelCandidates(primaryProvider)[0] || null;

        for(const providerCfg of configuredProviders){
            for(const model of getProviderModelCandidates(providerCfg.provider)){
                const remainingMs=getRemainingRequestTime(requestDeadlineAt);
                if(remainingMs<=0){deadlineExceeded=true;break;}
                const controller=new AbortController();
                const timeoutId=setTimeout(()=>controller.abort(),remainingMs);
                let response;
                try{
                    response=await fetch(providerCfg.endpoint,{method:'POST',headers:providerCfg.getHeaders(),body:JSON.stringify({model,messages:[{role:'user',content:[{type:'text',text:'Read the label in the image and extract exactly one real part number. Return only that code. Do not invent or guess values. If unreadable, respond exactly NO_PART_NUMBER. Important: carefully distinguish the letter O from the letter M — they look different and must not be confused.'},{type:'image_url',image_url:{url:`data:${imageMime};base64,${base64Image}`}}]}],max_tokens:32,temperature:0,stream:false}),signal:controller.signal});
                }catch(error){
                    if(error && (error.name==='AbortError' || String(error.name || '').toLowerCase()==='aborted')){deadlineExceeded=true;modelAttempts.push({provider:providerCfg.provider,model,error:'timeout'});break;}
                    throw error;
                }finally{clearTimeout(timeoutId);}
                if(deadlineExceeded) break;
                if(!response.ok){
                    const errorText=await readResponseBodyWithinDeadline(response,controller,requestDeadlineAt);
                    lastUpstreamStatus=response.status; modelAttempts.push({provider:providerCfg.provider,model,status:response.status});
                    console.error('[ocr] upstream API error:',{provider:providerCfg.provider,status:response.status,model,body:errorText});
                    continue;
                }
                const responseText=await readResponseBodyWithinDeadline(response,controller,requestDeadlineAt);
                let data; try{data=JSON.parse(responseText);}catch{throw new Error('Invalid OCR provider response');}
                const rawText=data?.choices?.[0]?.message ? extractTextContent(data.choices[0].message.content):'';
                const partNumber=extractPartNumberFromRawText(rawText);
                modelAttempts.push({provider:providerCfg.provider,model,rawText:String(rawText || '').slice(0,120),partNumber:partNumber || ''});
                if(partNumber){
                    if(debugInfo){debugInfo.provider=providerCfg.provider;debugInfo.model=model;debugInfo.modelAttempts=modelAttempts;}
                    const usageCounters=await recordMonthlyModelUsage(`${providerCfg.provider}:${model}`);
                    const providerFallbackUsed=!!(primaryProvider && providerCfg.provider!==primaryProvider);
                    const modelFallbackUsed=!!(primaryModel && model!==primaryModel);
                    return buildOcrSuccessResponse(corsHeaders,partNumber,debugInfo,{providerUsed:providerCfg.provider,providerFallbackUsed,modelUsed:model,modelFallbackUsed:providerFallbackUsed||modelFallbackUsed},usageCounters);
                }
            }
            if(deadlineExceeded) break;
        }
        if(debugInfo){debugInfo.provider=null;debugInfo.model=null;debugInfo.modelAttempts=modelAttempts;}
        if(deadlineExceeded) return jsonResponse({statusCode:504,corsHeaders,body:{error:'OCR request timed out',errorType:'timeout'}});
        if(lastUpstreamStatus && !modelAttempts.some(a=>a.partNumber) && !modelAttempts.some(a=>!a.status && !a.error)) return jsonResponse({statusCode:lastUpstreamStatus,corsHeaders,body:{error:`API error: ${lastUpstreamStatus}`}});
        const lastAttempt=modelAttempts.at(-1) || null;
        const lastProviderTried=lastAttempt?.provider || primaryProvider, lastModelTried=lastAttempt?.model || primaryModel;
        const usageCounters=await recordMonthlyModelUsage(`${lastProviderTried}:${lastModelTried}`);
        return buildOcrSuccessResponse(corsHeaders,'',debugInfo,{providerUsed:lastProviderTried,providerFallbackUsed:!!(primaryProvider && lastProviderTried && lastProviderTried!==primaryProvider),modelUsed:lastModelTried,modelFallbackUsed:!!(primaryModel && lastModelTried && lastModelTried!==primaryModel)},usageCounters);
    } catch(error){
        if(isOcrTimeoutError(error) || getRemainingRequestTime(requestDeadlineAt)<=0) return jsonResponse({statusCode:504,corsHeaders,body:{error:'OCR request timed out',errorType:'timeout'}});
        console.error('OCR function error:',error);
        return jsonResponse({statusCode:500,corsHeaders,body:{error:'Internal server error'}});
    }
};
