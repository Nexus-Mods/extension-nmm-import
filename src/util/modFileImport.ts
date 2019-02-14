import { IModEntry } from '../types/nmmEntries';

import * as Promise from 'bluebird';
import * as path from 'path';
import { fs } from 'vortex-api';

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
export function transferUnpackedMod(mod: IModEntry, nmmVirtualPath: string, nmmLinkPath: string,
                                    installPath: string, keepSource: boolean): Promise<string[]> {
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

  const failedFiles: string[] = [];
  return Promise.map(Array.from(directories).sort(byLength), dir => fs.ensureDirAsync(dir))
    .then(() => Promise.map(mod.fileEntries,
      file => {
        // We shouldn't include the mod's base directory; remove it from the file's source
        //  path. We ensure that the mod name is actually inside the realPath attribute 
        //  first just in case. (Not sure if that's a valid use case in NMM)
        const modNameIndex = file.fileSource.indexOf(mod.modName);
        const rootFilePath = modNameIndex !== -1 
          ? file.fileSource.substring(modNameIndex + mod.modName.length + 1)
          : file.fileSource;

        operation(path.join(nmmVirtualPath, file.fileSource),
        path.join(destPath, rootFilePath))
        .catch(err => {
          if ((err.code === 'ENOENT') && (nmmLinkPath)) {
            operation(path.join(nmmLinkPath, file.fileSource),
                      path.join(destPath, rootFilePath))
              .catch(linkErr => {
                failedFiles.push(file.fileSource + ' - ' + linkErr.message);
              });
          } else {
            failedFiles.push(file.fileSource + ' - ' + err.message);
          }
        })
      }))
    .then(() => Promise.resolve(failedFiles));
}
