import { IModEntry } from '../types/nmmEntries';

import * as Promise from 'bluebird';
import * as Redux from 'redux';
import { actions, types } from 'vortex-api';

export function addMetaData(gameID: string, modEntries: IModEntry[],
                            api: types.IExtensionApi) {
  Promise.map(modEntries, modEntry => {
    if (!!modEntry.categoryId) {
      api.store.dispatch(
        actions.setDownloadModInfo(modEntry.archiveId, 'custom.category', modEntry.categoryId));
    }

    if (!!modEntry.nexusId) {
      api.store.dispatch(
        actions.setDownloadModInfo(modEntry.archiveId, 'source', 'nexus'));
      api.store.dispatch(
        actions.setDownloadModInfo(modEntry.archiveId, 'nexus.ids.modId', modEntry.nexusId));
      api.store.dispatch(
        actions.setDownloadModInfo(modEntry.archiveId, 'nexus.ids.gameId', gameID));

      if (!!modEntry.modVersion) {
        api.store.dispatch(
          actions.setDownloadModInfo(modEntry.archiveId, 'version', modEntry.modVersion));
      }
      api.store.dispatch(
        actions.setDownloadModInfo(modEntry.archiveId, 'game', gameID));
      api.store.dispatch(
        actions.setDownloadModInfo(modEntry.archiveId, 'name', modEntry.modName));
    } else {
      // NMM did not store a modId for this mod. This is a valid
      //  case when a mod has been manually added to NMM.
      //  We're going to try and retrieve the nexus id from the file name
      //  if possible.
      const match = modEntry.modFilename.match(/-([0-9]+)-/);
      if (match !== null) {
        api.store.dispatch(
          actions.setDownloadModInfo(modEntry.archiveId, 'source', 'nexus'));
        api.store.dispatch(
          actions.setDownloadModInfo(modEntry.archiveId, 'nexus.ids.modId', match[1]));
      }
    }
  });
}

// Used to enable the imported mods for the specified profileId.
//  - Function will retrieve all mods installed for a certain gameId ( We expect
//  the mods to be installed inside Vortex's staging folder at this stage )
//
//  - Function will compare the provided mod entries against the persistent mods list
//  and will enable only the mod entries it finds within the persistent list.
export function installModsForProfile(gameId: string,
                                      profileId: string,
                                      state: any,
                                      modEntries: IModEntry[],
                                      dispatch: Redux.Dispatch<any>) {
  throw new Error('Not Implemented');
  // const mods: types.IMod[] = util.getSafe(state, ['persistent', 'mods', gameId], undefined);
  // if (mods === undefined) {
  //   return;
  // }

  // const isImported = (mod: types.IMod) => {
  //   return modEntries.find(entry => {
  //     const modName = entry.modFilename.substr(0, entry.modFilename.lastIndexOf('.'));
  //     return modName === mod.id;
  //   }) !== undefined;
  // };

  // const importedMods = Object.keys(mods).map(id => mods[id]).filter(isImported);
  // importedMods.forEach(mod => {
  //   enableMod(mod.id, profileId, dispatch);
  // });
}

function enableMod(modId: string, profileId: string, dispatch: Redux.Dispatch<any>) {
  dispatch(actions.setModEnabled(profileId, modId, true));
}
