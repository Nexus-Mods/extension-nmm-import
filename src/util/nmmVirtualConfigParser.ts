import { IFileEntry, IModEntry, ParseError } from '../types/nmmEntries';

import * as Promise from 'bluebird';
import * as modmeta from 'modmeta-db';
import * as path from 'path';
import { fs, log, types, util } from 'vortex-api';

interface IModMap {
  [modId: string]: types.IMod;
}

export function parseNMMConfigFile(nmmFilePath: string, mods: IModMap): Promise<IModEntry[]> {
  return fs.readFileAsync(nmmFilePath)
      .catch(
          err => Promise.reject(new ParseError(
              'The selected folder does not contain a VirtualModConfig.xml file.')))
      .then(data => parseModEntries(data.toString('utf-8'), mods, path.dirname(nmmFilePath)));
}

function getInner(ele: Element, tagName: string): string {
  return ele.getElementsByTagName(tagName)[0].childNodes[0].nodeValue;
}

function transformFileEntry(
    fileLink: Element, adjustRealPath: (input: string) => string): IFileEntry {
  const virtualPath = fileLink.getAttribute('virtualPath');
  if ((virtualPath === null) || (virtualPath === undefined)) {
    return undefined;
  }

  return {
    fileSource: adjustRealPath(fileLink.getAttribute('realPath')),
    fileDestination: virtualPath,
    isActive: getInner(fileLink, 'isActive').toLowerCase() === 'true',
    filePriority: parseInt(getInner(fileLink, 'linkPriority'), 10),
  };
}

// exported so it can be unit-tested (ugh)
export function parseModEntries(
    xmlData: string, mods: IModMap,
    virtualInstallPath: string): Promise<IModEntry[]> {
  const parser = new DOMParser();

  // lookup to determine if a mod is already installed in vortex
  const modListSet = new Set(Object.keys(mods || {}).map((key: string) => mods[key].id));

  const xmlDoc = parser.parseFromString(xmlData, 'text/xml');
  const version = xmlDoc.getElementsByTagName('virtualModActivator')[0];

  // sanity checks for the file structure
  if ((version === null) || (version === undefined)) {
    return Promise.reject(new ParseError(
        'The selected folder does not contain a valid VirtualModConfig.xml file.'));
  }

  if (version.getAttribute('fileVersion') !== '0.3.0.0') {
    return Promise.reject(new ParseError(
        'The selected folder contains an older VirtualModConfig.xml file,' +
        'you need to upgrade your NMM before proceeding with the mod import.'));
  }

  const modInfoList = xmlDoc.getElementsByTagName('modInfo');
  if ((modInfoList === undefined) || (modInfoList.length <= 0)) {
    return Promise.reject(new ParseError(
        'The selected folder contains an empty VirtualModConfig.xml file.'));
  }

  return Promise.map(Array.from(modInfoList), (modInfo: Element): Promise<IModEntry> => {
    const res: IModEntry = {
      nexusId: modInfo.getAttribute('modId'),
      vortexId: undefined,
      downloadId: parseInt(modInfo.getAttribute('downloadId'), 10) || undefined,
      modName: modInfo.getAttribute('modName'),
      modFilename: modInfo.getAttribute('modFileName'),
      archivePath: modInfo.getAttribute('modFilePath'),
      modVersion: modInfo.getAttribute('FileVersion'),
      importFlag: true,
      archiveMD5: null,
      isAlreadyManaged: false,
    };

    const archiveName =
        path.basename(res.modFilename, path.extname(res.modFilename));
    res.vortexId = util.deriveInstallName(archiveName, {});
    res.isAlreadyManaged = modListSet.has(res.vortexId);

    let useOldPath: boolean = false;

    // NMM has a crazy workaround where it will use an install path based on
    // the download id or the archive name, whatever is available.
    // Manually added mods seem to have neither! attempt to use the mod's name
    //  as a final resort.
    const adjustRealPath = (input: string): string => {
      return path.join(useOldPath
        ? archiveName
        : (res.downloadId !== undefined)
          ? res.downloadId.toString()
          : res.modName,
        ...input.split(path.sep).slice(1));
    };

    return fs.statAsync(path.join(virtualInstallPath, archiveName))
        .then(() => { useOldPath = true; })
        .catch(() => undefined)
        .then(() => {
          let fileLinks: NodeListOf<Element>;
          try {
            fileLinks = modInfo.getElementsByTagName('fileLink') as any;
          } catch (err) {
            log('warn', 'VirtualModConfig.xml has no file links for mod',
                { archiveName, error: err.message });
          }

          // if ((fileLinks !== undefined) && (fileLinks.length > 0)) {
          //   res.fileEntries =
          //       Array.from(fileLinks)
          //           .map(fileLink => transformFileEntry(fileLink, adjustRealPath))
          //           .filter(entry => entry !== undefined);
          // }

          const modFilePath = path.join(res.archivePath, res.modFilename);

          return modmeta.genHash(modFilePath);
        })
        .then((hashResult: modmeta.IHashResult) => {
          res.archiveMD5 = hashResult.md5sum;
        })
        .catch(() => { res.archiveMD5 = null; })
        .then(() => res);
  });
}

export default parseNMMConfigFile;
