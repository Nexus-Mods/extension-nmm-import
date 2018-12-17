import { setImportStep } from './actions/session';
import { sessionReducer } from './reducers/session';
import ImportDialog from './views/ImportDialog';

import { app as appIn, remote } from 'electron';
import * as path from 'path';
import { fs, types, selectors } from 'vortex-api';

const app = appIn !== undefined ? appIn : remote.app;

let appPath: string;

function nmmConfigExists(): boolean {
  try {
    if (appPath === undefined) {
      appPath = app.getPath('appData');
    }
    const base = path.resolve(appPath, '..', 'local', 'Black_Tree_Gaming');
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

  const gameModeActive = (store) => selectors.activeGameId(store.getState()) !== undefined 
    ? true
    : false;

  context.registerDialog('nmm-import', ImportDialog);

  context.registerReducer(['session', 'modimport'], sessionReducer);
  context.registerAction('mod-icons', 115, 'import', {}, 'Import From NMM', () => {
    context.api.store.dispatch(setImportStep('start'));
  });

  context.registerToDo('import-nmm', 'search', () => ({}), 'import', 'Import from NMM', () => {
    context.api.store.dispatch(setImportStep('start'));
  }, () => nmmConfigExists() && gameModeActive(context.api.store),  '', 100);

  context.once(() => {
    context.api.setStylesheet('nmm-import-tool', path.join(__dirname, 'import-tool.scss'));
  });

  return true;
}

export default init;
