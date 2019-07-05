import { IModEntry } from '../types/nmmEntries';

import * as Promise from 'bluebird';
import * as path from 'path';
import { fs, util } from 'vortex-api';

/**
 * copy or move a list of mod archives
 * @param {string} modArchive
 * @param {string} destSavePath
 */
export function transferArchive(modArchivePath: string,
                                destSavePath: string): Promise<void> {
  return fs.copyAsync(modArchivePath, path.join(destSavePath, path.basename(modArchivePath)));
}

function byLength(lhs: string, rhs: string): number {
  return lhs.length - rhs.length;
}

/**
 * copy or move a list of mod files
 * @param {ModEntry} mod
 * @param {string} nmmVirtualPath
 * @param {string} installPath
 * @param {boolean} keepSource
 */
export function transferUnpackedMod(mod: IModEntry,
                                    nmmVirtualPath: string,
                                    nmmLinkPath: string,
                                    installPath: string,
                                    keepSource: boolean): Promise<{hasTransferredFiles: boolean, errors: string[]}> {
  const operation = keepSource ? fs.copyAsync : fs.renameAsync;

  const destPath = path.join(installPath, mod.vortexId);

  // determine list of direcotries in the output directory. We create those
  // in a first step in the hope that this is faster than calling mkdirs
  // for each file individually
  const directories = new Set<string>();
  directories.add(destPath);
  mod.fileEntries.forEach(file => {
    directories.add(path.dirname(path.join(destPath, file.fileDestination)));
  });

  const errors: string[] = [];
  let hasTransferredFiles: boolean = false;
  return Promise.map(Array.from(directories).sort(byLength), dir => fs.ensureDirAsync(dir))
    .then(() => Promise.map(mod.fileEntries,
      file => {
        // At this point ideally, file.fileDestination would provide us with a
        //  relative path; unfortunately we have met cases where fileDestination is
        //  actually an absolute path so we need to ensure we cater for that as well.
        //  NOTE: NMM ^0.70.X no longer stores mods using the mod's name but rather
        //  by the downloadId (inconsistency is king on that side of the river).
        //
        // We _could_ attempt to get a relative path between the game's mods folder
        //  and the file destination we pulled from NMM; but then we don't have the
        //  guarantee that the user has set Vortex to use the same game installation...
        //  so we're going to take an ugly shortcut:
        //  - Check source for modName;
        //  - if source doesn't contain modName, check for downloadId
        //  - finally if we failed on all fronts, just let the user know
        //    that Vortex can't import this mod.
        let parentFolderName;
        let modNameIndex;
        const isDestAbs = path.isAbsolute(file.fileDestination);
        if (isDestAbs) {
          parentFolderName = mod.modName;
          modNameIndex = file.fileSource.indexOf(parentFolderName);
          if ((modNameIndex === -1) && (!!mod.downloadId)) {
            parentFolderName = mod.downloadId.toString(); // 0.70 uses downloadIds
            modNameIndex = file.fileSource.indexOf(parentFolderName);
          }
        }

        const rootFilePath = (!isDestAbs)
          ? file.fileDestination
          : (modNameIndex !== -1)
            ? file.fileSource.substring(modNameIndex + parentFolderName.length + 1)
            : undefined;

        return (rootFilePath !== undefined)
          ? operation(path.join(nmmVirtualPath, file.fileSource), path.join(destPath, rootFilePath))
          : Promise.reject(new util.DataInvalid('Unable to identify mod\'s root path'))
        .tap(() => {
          hasTransferredFiles = true;
        })
        .catch(err => {
          if ((err.code === 'ENOENT') && (nmmLinkPath)) {
            return operation(path.join(nmmLinkPath, file.fileSource),
                             path.join(destPath, rootFilePath))
              .tap(() => {
                hasTransferredFiles = true;
              })
              .catch(linkErr => {
                errors.push(file.fileSource + ' - ' + linkErr.message);
              });
          } else {
            errors.push(file.fileSource + ' - ' + err.message);
          }
        });
      }))
    .then(() => (!hasTransferredFiles)
      ? fs.removeAsync(destPath)
          .catch(err => {
            errors.push('Failed to clean-up directories for failed mod import'
                      + ' - ' + err.message);
            return Promise.resolve();
          }).then(() => Promise.resolve({hasTransferredFiles, errors}))
      : Promise.resolve({hasTransferredFiles, errors}));
}
