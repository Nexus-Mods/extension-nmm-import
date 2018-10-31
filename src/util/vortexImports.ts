import { IModEntry } from '../types/nmmEntries';

import * as Promise from 'bluebird';
import * as Redux from 'redux';
import { actions, log, types } from 'vortex-api';

export function createProfile(gameId: string, profileId: string,
                              profileName: string, dispatch: Redux.Dispatch<any>) {
  log ('info', 'Create profile: ', {gameId, profileId});
  dispatch(actions.setProfile({
    id: profileId,
    gameId,
    name: profileName,
    modState: {},
  }));
}

export function addMods(gameID: string, profileId: string,
                        modEntries: IModEntry[], dispatch: Redux.Dispatch<any>) {
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

    mods.push(mod);
  })
  .then(() => {
    dispatch(actions.addMods(gameID, mods));
  })
  .then(() => {
    Promise.map(mods, mod => {
      enableMod(mod.id, profileId, dispatch);
    });
  });
}

function enableMod(modId: string, profileId: string, dispatch: Redux.Dispatch<any>) {
  dispatch(actions.setModEnabled(profileId, modId, true));
}
