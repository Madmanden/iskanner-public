// Demo parts database for the public repository.
// This file intentionally contains only fake, non-operational sample data.
// Replace it with your own inventory before using the app in production.

var partsDatabase = {
    'DEMO-001': 'Demo cabinet A / shelf 1',
    'DEMO-002': 'Demo cabinet A / shelf 2',
    'DEMO-010': 'Demo cabinet B / shelf 1',
    'DEMO-011': 'Demo cabinet B / shelf 2',
    'SAMPLE-100': 'Demo rack C / drawer 1',
    'SAMPLE-101': 'Demo rack C / drawer 2',
    'TEST-200': 'Demo tray D / slot 1',
    'TEST-201': 'Demo tray D / slot 2',
    'FAKE-900': 'Demo storage E / bin 3',
    'FAKE-901': 'Demo storage E / bin 4'
};

if (typeof window !== 'undefined') {
    window.partsDatabase = partsDatabase;
}
