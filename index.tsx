import { declareIndexPlugin, type ReactRNPlugin } from '@remnote/plugin-sdk';
import '../style.css';
import '../index.css';

async function onActivate(plugin: ReactRNPlugin) {
  // Open the export window from the command palette (Ctrl/Cmd+K → "Export SRS data").
  await plugin.app.registerCommand({
    id: 'export-srs-data',
    name: 'Export SRS data (CSV)',
    action: async () => {
      await plugin.widget.openPopup('export_popup');
    },
  });
}

async function onDeactivate(_: ReactRNPlugin) {}

declareIndexPlugin(onActivate, onDeactivate);
