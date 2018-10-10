import { setImportStep } from './actions/session';
import { sessionReducer } from './reducers/session';
import ImportDialog from './views/ImportDialog';

import { app as appIn, remote } from 'electron';
import * as path from 'path';
import { fs, types } from 'vortex-api';

const app = appIn !== undefined ? appIn : remote.app;

function nmmConfigExists(): boolean {
  try {
    const base = path.resolve(app.getPath('appData'), '..', 'local', 'Black_Tree_Gaming');
    fs.statSync(base);
    return true;
  } catch (err) {
    return false;
  }
}

function init(context: types.IExtensionContext): boolean {
  if (process.platform !== 'win32') {
    // not going to work on other platforms because some of the path resolution
    // assumes windows.
    return false;
  }

  context.registerDialog('nmm-import', ImportDialog);

  context.registerReducer(['session', 'modimport'], sessionReducer);
  context.registerAction('mod-icons', 115, 'import', {}, 'Import From NMM', () => {
    context.api.store.dispatch(setImportStep('start'));
  });

  context.registerToDo('import-nmm', 'search', () => ({}), 'import', 'Import from NMM', () => {
    context.api.store.dispatch(setImportStep('start'));
  }, () => nmmConfigExists(),  '', 100);

  context.once(() => {
    context.api.setStylesheet('nmm-import-tool', path.join(__dirname, 'import-tool.scss'));
  });

  return true;
}

export default init;
