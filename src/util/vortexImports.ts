import { IModEntry } from '../types/nmmEntries';

import * as Promise from 'bluebird';
import * as Redux from 'redux';
import { actions, types, util } from 'vortex-api';

export function addMods(gameID: string, modEntries: IModEntry[],
                        api: types.IExtensionApi) {
  const store = api.store;
  const state = store.getState();
  const mods: types.IMod[] = [];

  Promise.map(modEntries, modEntry => {
    const modName = modEntry.modFilename.substr(0, modEntry.modFilename.lastIndexOf('.'));
    const mod: types.IMod = {
      id: modName,
      type: '',
      state: 'installed',
      installationPath: modName,
      archiveId: modEntry.archiveId,
      attributes: {
        name: modName,
        installTime: new Date(),
        customFileName: modEntry.customName,
        version: modEntry.modVersion,
        fileId: modEntry.downloadId,
        fileMD5: modEntry.archiveMD5,
        notes: 'Imported using the NMM-Import-Tool',
        category: modEntry.categoryId,
      },
    };
    if (modEntry.nexusId) {
      mod.attributes.source = 'nexus';
      mod.attributes.modId = modEntry.nexusId;
    } else {
      // NMM did not store a modId for this mod. This is a valid
      //  case when a mod has been manually added to NMM.
      //  We're going to try and retrieve the nexus id from the file name
      //  if possible.
      const match = modEntry.modFilename.match(/-([0-9]+)-/);
      if (match !== null) {
        mod.attributes.source = 'nexus';
        mod.attributes.modId = match[1];
      }
    }

    // We should now add this metadata to the archive we imported.
    // - IF we imported the archive.
    // - IF it's from nexus.
    const archive = util.getSafe(state,
      ['persistent', 'downloads', 'files', mod.archiveId], undefined);

    if ((archive !== undefined)
    && (mod.attributes.source === 'nexus')) {
      api.store.dispatch(
        actions.setDownloadModInfo(mod.archiveId, 'source', mod.attributes.source));
      api.store.dispatch(
        actions.setDownloadModInfo(mod.archiveId, 'nexus.ids.modId', mod.attributes.modId));
      api.store.dispatch(
        actions.setDownloadModInfo(mod.archiveId, 'nexus.ids.gameId', gameID));

      if (!!modEntry.modVersion) {
        api.store.dispatch(
          actions.setDownloadModInfo(mod.archiveId, 'version', modEntry.modVersion));
      }
      api.store.dispatch(
        actions.setDownloadModInfo(mod.archiveId, 'game', gameID));
      api.store.dispatch(
        actions.setDownloadModInfo(mod.archiveId, 'name', modName));
    }

    mods.push(mod);
  })
  .then(() => { store.dispatch(actions.addMods(gameID, mods)); });
}

// Used to enable the imported mods for the specified profileId.
//  - Function will retrieve all mods installed for a certain gameId ( We expect
//  the mods to be installed inside Vortex's staging folder at this stage )
//
//  - Function will compare the provided mod entries against the persistent mods list
//  and will enable only the mod entries it finds within the persistent list.
export function enableModsForProfile(gameId: string,
                                     profileId: string,
                                     state: any,
                                     modEntries: IModEntry[],
                                     dispatch: Redux.Dispatch<any>) {
  const mods: types.IMod[] = util.getSafe(state, ['persistent', 'mods', gameId], undefined);
  if (mods === undefined) {
    return;
  }

  const isImported = (mod: types.IMod) => {
    return modEntries.find(entry => {
      const modName = entry.modFilename.substr(0, entry.modFilename.lastIndexOf('.'));
      return modName === mod.id;
    }) !== undefined;
  };

  const importedMods = Object.keys(mods).map(id => mods[id]).filter(isImported);
  importedMods.forEach(mod => {
    enableMod(mod.id, profileId, dispatch);
  });
}

function enableMod(modId: string, profileId: string, dispatch: Redux.Dispatch<any>) {
  dispatch(actions.setModEnabled(profileId, modId, true));
}
