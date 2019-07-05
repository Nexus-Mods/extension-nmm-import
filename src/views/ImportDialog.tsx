import { setImportStep } from '../actions/session';

import { IModEntry } from '../types/nmmEntries';
import { getCategories } from '../util/categories';
import findInstances from '../util/findInstances';
import importMods from '../util/import';
import parseNMMConfigFile from '../util/nmmVirtualConfigParser';
import { enableModsForProfile } from '../util/vortexImports';

import { generate as shortid } from 'shortid';
import * as winapi from 'winapi-bindings';
import TraceImport from '../util/TraceImport';

import {
  FILENAME, FILES, LOCAL, MOD_ID, MOD_NAME, MOD_VERSION,
} from '../importedModAttributes';

import * as path from 'path';
import * as React from 'react';
import { Alert, Button, MenuItem, ProgressBar, SplitButton } from 'react-bootstrap';
import { withTranslation } from 'react-i18next';
import { connect } from 'react-redux';
import * as Redux from 'redux';
import { actions, ComponentEx, fs, Icon, ITableRowAction, Modal,
         selectors, Spinner, Steps, Table, Toggle, types, util } from 'vortex-api';

import * as Promise from 'bluebird';

type Step = 'start' | 'setup' | 'working' | 'review';

// Used to reduce the amount of detected free space by 500MB.
//  This is done to avoid situations where the user may be left
//  with no disk space after the import process is finished.
const MIN_DISK_SPACE_OFFSET = (500 * (1e+6));

const _LINKS = {
  TO_CONSIDER: 'https://wiki.nexusmods.com/index.php/Importing_from_Nexus_Mod_Manager:_Things_to_consider',
  FOMOD_LINK: 'https://wiki.nexusmods.com/index.php/Importing_from_Nexus_Mod_Manager:_Things_to_consider#Scripted_Installers_.2F_FOMOD_Installers',
  UNMANAGED: 'https://wiki.nexusmods.com/index.php/Importing_from_Nexus_Mod_Manager:_Things_to_consider#Unmanaged_Files',
  FILE_CONFLICTS: 'https://wiki.nexusmods.com/index.php/File_Conflicts:_Nexus_Mod_Manager_vs_Vortex',
  MANAGE_CONFLICTS: 'https://wiki.nexusmods.com/index.php/Managing_File_Conflicts',
  DOCUMENTATION: 'https://wiki.nexusmods.com/index.php/Category:Vortex',
};

interface IConnectedProps {
  gameId: string;
  downloadPath: string;
  installPath: string;
  importStep?: Step;
  profiles: {[id: string]: types.IProfile};
  activeProfile: types.IProfile;
  profilesVisible: boolean;
}

interface ICapacityInfo {
  desc: string;
  rootPath: string;
  totalNeededBytes: number;
  totalFreeBytes: number;
  hasCalculationErrors: boolean;
}

interface IModCapacityInfo {
  modSizeBytes: number;
  archiveSizeBytes: number;
}

interface IActionProps {
  onSetStep: (newState: Step) => void;
  onCreateProfile: (newProfile: types.IProfile) => void;
}

type IProps = IConnectedProps & IActionProps;

interface IComponentState {
  sources: string[][];
  selectedSource: string[];
  selectedProfile: { id: string, profile: types.IProfile };
  importArchives: boolean;
  modsToImport: { [id: string]: IModEntry };
  error: string;
  importEnabled: { [id: string]: boolean };
  counter: number;
  progress: { mod: string, pos: number };
  failedImports: string[];

  capacityInformation: { [id: string]: ICapacityInfo };
  modsCapacity: { [id: string]: IModCapacityInfo };

  // Array to hold conflicted mod names.
  conflictedMods: string[];

  // Array of successfully imported mod entries.
  successfullyImported: IModEntry[];

  // Dictates whether mods will be automatically
  //  enabled at the end of the import process.
  enableModsOnFinish: boolean;

  // We don't want to allow users to create infinite amount
  //  of new profiles from within the import process, this
  //  variable will hold a reference to the newly created profile.
  newProfile: types.IProfile;
}

class ImportDialog extends ComponentEx<IProps, IComponentState> {
  private static STEPS: Step[] = [ 'start', 'setup', 'working', 'review' ];

  private mStatus: types.ITableAttribute;
  private mTrace: TraceImport;
  private actions: ITableRowAction[];

  constructor(props: IProps) {
    super(props);

    this.initState({
      sources: undefined,
      importArchives: true,
      modsToImport: undefined,
      modsCapacity: undefined,
      selectedSource: [],
      error: undefined,
      importEnabled: {},
      counter: 0,
      progress: undefined,
      failedImports: [],

      capacityInformation: {
        modFiles: {
          desc: 'Mod Files',
          rootPath: '',
          totalNeededBytes: 0,
          totalFreeBytes: 0,
          hasCalculationErrors: false,
        },
        archiveFiles: {
          desc: 'Archive Files',
          rootPath: '',
          totalNeededBytes: 0,
          totalFreeBytes: 0,
          hasCalculationErrors: false,
        },
      },

      selectedProfile: undefined,
      enableModsOnFinish: true,
      newProfile: undefined,
      conflictedMods: [],
      successfullyImported: [],
    });

    this.actions = [
      {
        icon: 'checkbox-checked',
        title: 'Import',
        action: this.importSelected,
        singleRowAction: false,
      },
      {
        icon: 'checkbox-unchecked',
        title: 'Don\'t Import',
        action: this.dontImportSelected,
        singleRowAction: false,
      },
    ];

    this.mStatus = {
      id: 'status',
      name: 'Import',
      description: 'The import status of the mod',
      icon: 'level-up',
      calc: (mod: IModEntry) => this.isModEnabled(mod) ? 'Import' : 'Don\'t import',
      placement: 'both',
      isToggleable: true,
      isSortable: true,
      isVolatile: true,
      edit: {
        inline: true,
        choices: () => [
          { key: 'yes', text: 'Import' },
          { key: 'no', text: 'Don\'t import' },
        ],
        onChangeValue: (mod: IModEntry, value: any) => {
          this.nextState.importEnabled[mod.modFilename] = (value === undefined)
            ? mod.isAlreadyManaged
               ? !(this.state.importEnabled[mod.modFilename] === true)
               : !(this.state.importEnabled[mod.modFilename] !== false)
            : value === 'yes';
          ++this.nextState.counter;
          // Avoid calculating for mods that are already managed by Vortex.
          if (!mod.isAlreadyManaged) {
            this.recalculate();
          } else {
            return null;
          }
        },
      },
    };
  }

  public componentWillReceiveProps(newProps: IProps) {
    if (this.props.importStep !== newProps.importStep) {
      if (newProps.importStep === 'start') {
        this.resetStateData();
        this.start();
      } else if (newProps.importStep === 'setup') {
        this.setup();
      } else if (newProps.importStep === 'working') {
        this.startImport();
      } else if (newProps.importStep === 'review') {
        this.nextState.successfullyImported = this.getSuccessfullyImported();
      }
    }
  }

  public render(): JSX.Element {
    const { t, importStep } = this.props;
    const { error, sources, capacityInformation,
            importArchives } = this.state;

    const canCancel = ((['start', 'setup'].indexOf(importStep) !== -1)
                   || (error !== undefined));
    const nextLabel = ((sources !== undefined) && (sources.length > 0))
      ? this.nextLabel(importStep)
      : undefined;

    const onClick = () => importStep !== 'review'
      ? this.next()
      : this.finish();

    const hasCalculationErrors = (capacityInformation.modFiles.hasCalculationErrors)
      || (capacityInformation.archiveFiles.hasCalculationErrors);

    let merged: ICapacityInfo;
    if (this.isIdenticalRootPath()) {
      merged = {
        desc: '',
        rootPath: capacityInformation.modFiles.rootPath,
        totalFreeBytes: capacityInformation.modFiles.totalFreeBytes,
        totalNeededBytes: capacityInformation.modFiles.totalNeededBytes +
                          capacityInformation.archiveFiles.totalNeededBytes,
        hasCalculationErrors,
      };
    }
    return (
      <Modal id='import-dialog' show={importStep !== undefined} onHide={this.nop}>
        <Modal.Header>
          <Modal.Title>{t('Nexus Mod Manager (NMM) Import Tool')}</Modal.Title>
          {this.renderCurrentStep()}
        </Modal.Header>
        <Modal.Body style={{ height: '60vh', display: 'flex', flexDirection: 'column' }}>
          {error !== undefined ? <Alert bsStyle='danger'>{error}</Alert> : this.renderContent(importStep)}
        </Modal.Body>
        <Modal.Footer>
          {importStep === 'setup'
            && (merged !== undefined
              ? this.getCapacityInfo(merged)
              : this.getCapacityInfo(capacityInformation.modFiles))}
          {importStep === 'setup'
            && importArchives
            && !this.isIdenticalRootPath()
            && this.getCapacityInfo(capacityInformation.archiveFiles)}
          {(importStep === 'setup') && hasCalculationErrors ? (
            <Alert bsStyle='danger'>
              {t('Vortex cannot validate NMM\'s mod/archive files - this usually occurs when '
                + 'the NMM configuration is corrupt')}
            </Alert>
          ) : null}
          {canCancel ? <Button onClick={this.cancel}>{t('Cancel')}</Button> : null}
          { nextLabel ? (
            <Button disabled={this.isNextDisabled()} onClick={onClick}>{nextLabel}</Button>
           ) : null }
        </Modal.Footer>
      </Modal>
    );
  }

  // Reset all previously set data.
  private resetStateData() {
    this.nextState.sources = undefined;
    this.nextState.importArchives = true;
    this.nextState.modsToImport = undefined;
    this.nextState.modsCapacity = undefined;
    this.nextState.selectedSource = [];
    this.nextState.error = undefined;
    this.nextState.importEnabled = {};
    this.nextState.counter = 0;
    this.nextState.progress = undefined;
    this.nextState.failedImports = [];
    this.nextState.capacityInformation = {
      modFiles: {
        desc: 'Mod Files',
        rootPath: '',
        totalNeededBytes: 0,
        totalFreeBytes: 0,
        hasCalculationErrors: false,
      },
      archiveFiles: {
        desc: 'Archive Files',
        rootPath: '',
        totalNeededBytes: 0,
        totalFreeBytes: 0,
        hasCalculationErrors: false,
      },
    };
    this.nextState.selectedProfile = undefined;
    this.nextState.enableModsOnFinish = true;
    this.nextState.newProfile = undefined;
    this.nextState.conflictedMods = [];
    this.nextState.successfullyImported = [];
  }

  private onGroupAction(entries: string[], enable: boolean) {
    const { importEnabled, modsToImport } = this.state;
    if (modsToImport === undefined) {
      // happens if there are no NMM mods for this game
      return Promise.resolve();
    }
    entries.forEach((key: string) => {
      if (importEnabled[key] !== undefined && importEnabled[key] === enable) {
        return;
      }

      // We're going to assign this value even if importEnabled object doesn't have
      //  a record of this key - which is a valid case when we just open up the
      //  NMM tool.
      this.nextState.importEnabled[key] = enable;
    });

    this.recalculate();
  }

  private importSelected = (entries) => {
    this.onGroupAction(entries, true);
  }

  private dontImportSelected = (entries) => {
    this.onGroupAction(entries, false);
  }

  private recalculate() {
    const { modFiles, archiveFiles } = this.nextState.capacityInformation;
    modFiles.hasCalculationErrors = false;
    archiveFiles.hasCalculationErrors = false;
    modFiles.totalNeededBytes = this.calcModFiles();
    archiveFiles.totalNeededBytes = this.calcArchiveFiles();
  }

  private getModNumber(): string {
    const { modsToImport } = this.state;
    if (modsToImport === undefined) {
      return '';
    }

    const modList = Object.keys(modsToImport).map(id => modsToImport[id]);
    const enabledMods = modList.filter(mod => this.isModEnabled(mod));

    return `${enabledMods.length} / ${modList.length}`;
  }

  private onStartUp(): Promise<void> {
    const { modsToImport } = this.nextState;
    if ((modsToImport === undefined) || (Object.keys(modsToImport).length === 0)) {
      // happens if there are no NMM mods for this game
      return Promise.resolve();
    }

    const modList = Object.keys(modsToImport)
      .map(id => modsToImport[id]);

    return this.calculateModsCapacity(modList);
  }

  private calculateModsCapacity(modList: IModEntry[]): Promise<void> {
    const { modFiles, archiveFiles } = this.nextState.capacityInformation;
    const modCapacityInfo: { [id: string]: IModCapacityInfo } = {};
    return Promise.mapSeries(modList, mod => this.calculateModFilesSize(mod)
      .then(modSizeBytes => this.calculateArchiveSize(mod)
        .then(archiveSizeBytes => {
          modCapacityInfo[mod.modFilename] = { modSizeBytes, archiveSizeBytes };
          return Promise.resolve();
        })
        .catch(() => {
          archiveFiles.hasCalculationErrors = true;
          modCapacityInfo[mod.modFilename] = { modSizeBytes, archiveSizeBytes: undefined };
          return Promise.resolve();
      }))
      .catch(() => {
        modFiles.hasCalculationErrors = true;
        modCapacityInfo[mod.modFilename] = { modSizeBytes: undefined, archiveSizeBytes: undefined };
        return Promise.resolve();
      }))
    .then(() => {
      this.nextState.modsCapacity = modCapacityInfo;
      this.recalculate();
      return Promise.resolve();
    });
  }

  private calcModFiles() {
    const { modsCapacity, modsToImport } = this.nextState;
    return ((modsCapacity !== undefined) && (modsToImport !== undefined))
      ? Object.keys(modsCapacity)
        .filter(id => this.modWillBeEnabled(modsToImport[id]))
        .map(id => modsCapacity[id])
        .reduce((total, mod) => {
          if (mod.modSizeBytes !== undefined) {
            return total + mod.modSizeBytes;
          } else {
            this.nextState.capacityInformation.modFiles.hasCalculationErrors = true;
            return total;
          }
        }, 0)
      : 0;
  }

  private calcArchiveFiles() {
    const { modsCapacity, modsToImport, importArchives } = this.nextState;
    return (importArchives
      && (modsCapacity !== undefined)
      && (modsToImport !== undefined))
        ? Object.keys(modsCapacity)
            .filter(id => this.modWillBeEnabled(modsToImport[id]))
            .map(id => modsCapacity[id])
            .reduce((total, mod) => {
              if (mod.archiveSizeBytes !== undefined) {
                return total + mod.archiveSizeBytes;
              } else {
                this.nextState.capacityInformation.archiveFiles.hasCalculationErrors = true;
                return total;
              }
            }, 0)
        : 0;
  }

  private calculateArchiveSize(mod: IModEntry): Promise<number> {
    return fs.statAsync(path.join(mod.archivePath, mod.modFilename))
      .then(stats => stats.size)
      .catch(util.UserCanceled, () => Promise.resolve(0));
  }

  private calculateModFilesSize(mod: IModEntry): Promise<number> {
    const { selectedSource, conflictedMods } = this.state;
    return Promise.map(mod.fileEntries, file => {

      // Given that we're reading through the file entries, this
      //  is a good point to check whether the NMM installation had
      //  any file conflicts.
      //
      // It's important to note that this logic will not execute when/if the
      //  user decides to import a mod which is already managed by Vortex
      //  but that is arguably acceptable given that the user may already have
      //  rules set up for that mod.
      if (!file.isActive && conflictedMods.find(conf => conf === mod.modName) === undefined) {
        // The file is inactive - it's safe to assume that the NMM
        //  installation had some conflicts.
        this.nextState.conflictedMods.push(mod.modName);
      }

      const filePath = path.join(selectedSource[0], 'VirtualInstall', file.fileSource);
      return fs.statAsync(filePath);
    }).then(stats => {
      const sum = stats.reduce((previous, stat) => previous + stat.size, 0);
      return Promise.resolve(sum);
    });
  }

  private commenceSwitch(profileId: string) {
    const { profiles } = this.props;
    const store = this.context.api.store;

    const isValidProfile = (): boolean => {
      return Object.keys(profiles).filter(id => id === profileId) !== undefined;
    };

    if (profileId !== undefined && isValidProfile()) {
      store.dispatch((actions as any).setNextProfile(profileId));
    }
  }

  // To be used after the import process finished. Will return
  //  an array containing successfully imported mods. This will
  //  ignore archive import errors as the mods should still
  //  be deployable even if the archives encountered issues.
  private getSuccessfullyImported(): IModEntry[] {
    const { failedImports, modsToImport } = this.state;
    const enabledMods = Object.keys(modsToImport)
      .map(id => modsToImport[id])
      .filter(mod => this.isModEnabled(mod));

    if (failedImports === undefined || failedImports.length === 0) {
      return enabledMods;
    }

    return enabledMods.filter(mod =>
      failedImports.find(fail => fail === mod.modName) === undefined);
  }

  private createANewProfile(): Promise<types.IProfile> {
    const { t, gameId, onCreateProfile, activeProfile } = this.props;
    const { newProfile } = this.state;

    if (newProfile !== undefined) {
      return Promise.resolve(newProfile);
    }

    return new Promise<types.IProfile>((resolve, reject) => {
      const newId = shortid();
      this.context.api.showDialog('question', t('Create new profile'), {
          input: [{ id: 'profileName', value: '', label: t('Profile Name') }],
      }, [{label: t('Cancel')}, {label: t('Create Profile')}])
      .then((result: types.IDialogResult) => {
        if (result.action === t('Create Profile')) {
          const newProf: types.IProfile = {
            id: newId,
            gameId,
            name: result.input.profileName,
            modState: {},
            lastActivated: 0,
          };
          onCreateProfile(newProf);
          this.nextState.newProfile = newProf;
          return resolve(newProf);
        } else {
          return resolve(activeProfile);
        }
      });
    });
  }

  private getProfileText(profile: types.IProfile): string {
    return profile.name + '/' + profile.id;
  }

  private notifySwitchProfile() {
    const { t, activeProfile } = this.props;
    const {selectedProfile} = this.state;

    const openDialog = () => {
      this.context.api.showDialog('info', 'Switch Profile', {
        bbcode: t('The currently active profile is: "{{active}}"; you chose to enable ' +
                  'the imported mods for a different profile named: "{{selected}}", ' +
                  'would you like to switch to this profile now? - installer (FOMOD) ' +
                  'settings will be preserved<br /><br />' +
                  'Choosing \"Switch Profile\" will switch over to the import profile. ' +
                  'Choosing "Close" will keep your currently active profile. <br /><br />' +
                  'Please note when switching: although mods will be enabled by default, ' +
                  'plugins require you to enable them [b]MANUALLY![/b] please enable your ' +
                  'plugins manually once the profile switch is complete!<br /><br />' +
                  'If you want to switch profiles at a later point in time and need help, ' +
                  'please consult our wiki:<br /><br />' +
                  '[url=https://wiki.nexusmods.com/index.php/Setting_up_profiles_in_Vortex]' +
                  'Setting up profiles in Vortex[/url]',
                  {
                    replace: {
                      active: this.getProfileText(activeProfile),
                      selected: this.getProfileText(selectedProfile.profile),
                    },
                  }),
        options: { wrap: true },
      }, [
        {
          label: 'Close',
        },
        {
          label: 'Switch Profile', action: () => this.commenceSwitch(selectedProfile.id),
        },
      ]);
    };

    this.context.api.sendNotification({
      type: 'info',
      title: t('Switch Profile'),
      message: t('A new NMM profile has been created as part of the import process. Switch to '
               + 'the newly created profile?'),
      noDismiss: true,
      actions: [
        {
          title: 'Switch',
          action: dismiss => {
            openDialog();
            dismiss();
          },
        },
        {
          title: 'Dismiss',
          action: dismiss => {
            openDialog();
            dismiss();
          },
        },
      ],
    });
  }

  private getCapacityInfo(instance: ICapacityInfo): JSX.Element {
    const { t } = this.props;
    return (
      <div>
          <p className={(instance.totalNeededBytes > instance.totalFreeBytes) || this.testSumBreach() ? 'disk-space-insufficient' : 'disk-space-sufficient'}>
            {
            t('{{desc}}: {{rootPath}} - Size required: {{required}} / {{available}}', {
              replace: {
                desc: t(instance.desc),
                rootPath: instance.rootPath,
                required: instance.hasCalculationErrors ? '???' : util.bytesToString(instance.totalNeededBytes),
                available: util.bytesToString(instance.totalFreeBytes),
              },
            })
            }
          </p>
      </div>
    );
  }

  /**
   * Runs all necessary capacity information checks for disabling the import button.
   *  Checks will include:
   *  - Ensure that all ICapacityInformation objects do not surpass the number
   *    of free bytes available on their target partition.
   *
   *  - Compare root paths between archive files and mod files.
   *    If both entries are installed on the same partition, we need to ensure
   *    that there's enough space for both to install on that drive.
   *
   * @returns True if a "breach" is confirmed and we want the import button to be disabled.
   *          False if it's safe for the user to click the import button.
   */
  private testCapacityInfoBreaches(): boolean {
    const { capacityInformation } = this.state;
    const capList = Object.keys(capacityInformation).map(id => capacityInformation[id]);

    if (capList.find(cap => cap.totalNeededBytes > cap.totalFreeBytes) !== undefined) {
      return true;
    }

    if (this.testSumBreach()) {
      return true;
    }

    return false;
  }

  /**
   * @returns True if modFiles and archiveFiles are on the same disk drive AND
   *  the sum of both capacityInfo objects surpasses the amount of free space.
   *
   * ....Naming stuff is hard....
   */
  private testSumBreach(): boolean {
    const { archiveFiles, modFiles } = this.state.capacityInformation;
    if (modFiles.rootPath === archiveFiles.rootPath) {
      if ((modFiles.totalNeededBytes + archiveFiles.totalNeededBytes) > modFiles.totalFreeBytes) {
        return true;
      }
    }
    return false;
  }

  private isNextDisabled = () => {
    const { importStep } = this.props;
    const { error, modsToImport } = this.state;

    const enabled = (modsToImport !== undefined)
      ? Object.keys(modsToImport).filter(id => this.isModEnabled(modsToImport[id]))
      : [];

    return (error !== undefined)
        || ((importStep === 'setup') && (modsToImport === undefined))
        || ((importStep === 'setup') && (enabled.length === 0))
        || ((importStep === 'setup') && (this.testCapacityInfoBreaches()));
  }

  private renderCurrentStep(): JSX.Element {
    const { t, importStep } = this.props;

    return (
      <Steps step={importStep} style={{ marginBottom: 32 }}>
        <Steps.Step
          key='start'
          stepId='start'
          title={t('Start')}
          description={t('Introduction')}
        />
        <Steps.Step
          key='setup'
          stepId='setup'
          title={t('Setup')}
          description={t('Select Mods to import')}
        />
        <Steps.Step
          key='working'
          stepId='working'
          title={t('Import')}
          description={t('Magic happens')}
        />
        <Steps.Step
          key='review'
          stepId='review'
          title={t('Review')}
          description={t('Import result')}
        />
      </Steps>
    );
  }

  private openLink = (evt: React.MouseEvent<HTMLAnchorElement>) => {
    evt.preventDefault();
    const link = evt.currentTarget.getAttribute('data-link');
    util.opn(link).catch(() => null);
  }

  private getLink(link: string, text: string): JSX.Element {
    const { t } = this.props;
    return (<a data-link={link} onClick={this.openLink}>{t(`${text}`)}</a>);
  }

  private renderContent(state: Step): JSX.Element {
    switch (state) {
      case 'start': return this.renderStart();
      case 'setup': return this.renderSelectMods();
      case 'working': return this.renderWorking();
      case 'review': return this.renderReview();
      default: return null;
    }
  }

  private renderStart(): JSX.Element {
    const { t, profilesVisible } = this.props;
    const { sources, selectedSource } = this.state;

    const optionalContent = profilesVisible
      ? (
        <li>
          {t('give you the choice of importing mods into your currently active profile, or create '
           + 'a new import profile in step 4.')}
        </li>)
      : null;

    return (
      <span
        style={{
          display: 'flex', flexDirection: 'column',
          justifyContent: 'space-around', height: '100%',
        }}
      >
        <div>
          {t('This is an import tool that allows you to bring your mods over from an existing '
          + 'NMM installation.')} <br/>
          {t('Please note that the process has a number of limitations, and')} <br/>
          {this.getLink(_LINKS.TO_CONSIDER,
            'starting with a fresh mod install is therefore recommended.')}
        </div>
        <div>
          <div className='import-will'>
            <Icon name='feedback-success' />
            {t('The import tool will:')}
          </div>
          <ul>
            <li>{t('copy all mods that are currently managed by NMM over to Vortex.')}</li>

            <li>
              {t('preserve your chosen ')}
              {this.getLink(_LINKS.FOMOD_LINK, 'scripted installer (FOMOD) ')}
              {t('options for mods installed via NMM.')}
            </li>

            <li>{t('reorder your plugin list based on LOOT rules.')}</li>
            <li>{t('require sufficient disk space as imported mods will '
                 + 'be copied (rather than moved).')}</li>
            {optionalContent}
            <li>{t('leave your existing NMM installation unmodified.')}</li>
          </ul>
        </div>
        <div>
          <div className='import-wont'>
            <Icon name='feedback-error' />
            {t('The import tool won’t:')}
          </div>
          <ul>
            <li>
              {t('import any mod files in your data folder that are ')}
              {this.getLink(_LINKS.UNMANAGED, 'not managed by NMM. ')}
              {t('If you have mods reliant on unmanaged files, those mods might not work as ')}
              {t('expected in your Vortex profile.')}
            </li>
            <li>
              {t('import your overwrite decisions. After importing, Vortex will allow you to ') +
               t('decide your mod overwrites dynamically, without needing to reinstall mods.')}
            </li>
            <li>
              {t('preserve your plugin load order, '
               + 'as plugins will be rearranged according to LOOT rules.')}
            </li>
          </ul>
        </div>
        {sources === undefined
          ? <Spinner />
          : sources.length === 0
            ? this.renderNoSources()
            : this.renderSources(sources, selectedSource)
        }
      </span>
    );
  }

  /**
   * Will render the following sequentially:
   * - A create new profile element which will open a dialog requesting a name
   *   for the newly create profile.
   * - The active profile, prefixed by "Active Profile:" to highlight which profile
   *   is the currently selected profile.
   * - All other profiles assigned to the current gameId.
   */
  private renderProfiles(): JSX.Element {
    const { selectedProfile, newProfile } = this.state;
    const { t, profiles, activeProfile } = this.props;

    const profileList = Object.keys(profiles).map(id => profiles[id]);

    return (
      <div>
        {t('Please select a profile to import to:')}
        <SplitButton
          id='import-select-profile'
          title={selectedProfile !== undefined ? selectedProfile.profile.name : 'error'}
          onSelect={this.selectProfile}
          style={{ marginLeft: 15 }}
        >
          {(newProfile === undefined)
            && this.renderProfileElement(t('Create New Profile'), '_create_new_profile_')}
          {this.renderProfileElement(t('Active Profile: ') + activeProfile.name,
            '_currently_active_profile_')}
          {profileList.map(prof => (prof.id !== activeProfile.id)
            ? this.renderProfileElement(prof.name, prof.id)
            : null)}
        </SplitButton>
      </div>
    );
  }

  private renderProfileElement = (option, evKey?): JSX.Element => {
    const key = evKey !== undefined ? evKey : option;
    return <MenuItem key={key} eventKey={key}>{option}</MenuItem>;
  }

  private renderNoSources(): JSX.Element {
    const { t } = this.props;

    return (
      <span className='import-errors'>
        <Icon name='feedback-error' />
        {' '}
        {t('No NMM install found with mods for this game. ' +
          'Please note that only NMM >= 0.63 is supported.')}
      </span>
    );
  }

  private renderSources(sources: string[][], selectedSource: string[]): JSX.Element {
    const { t } = this.props;

    return (
      <div>
        {t('If you have multiple instances of NMM installed you can select which one '
          + 'to import here:')}
        <SplitButton
          id='import-select-source'
          title={selectedSource !== undefined ? selectedSource[0] || '' : ''}
          onSelect={this.selectSource}
          style={{ marginLeft: 15 }}
        >
          {sources.map(this.renderSource)}
        </SplitButton>
      </div>
    );
  }

  private renderSource = option => {
    return <MenuItem key={option} eventKey={option}>{option[0]}</MenuItem>;
  }

  private toggleEnableOnFinish = () => {
    const { enableModsOnFinish } = this.state;
    this.nextState.enableModsOnFinish = !enableModsOnFinish;
  }

  private toggleArchiveImport = () => {
    const { importArchives } = this.state;
    this.nextState.importArchives = !importArchives;
    this.recalculate();
  }

  private renderSelectMods(): JSX.Element {
    const { t } = this.props;
    const { counter, importArchives, modsToImport } = this.state;

    const content = (modsToImport === undefined)
      ? (
        <div className='spinner-container'>
            <Icon name='spinner' />
        </div>
      ) : (
        <Table
          tableId='mods-to-import'
          data={modsToImport}
          dataId={counter}
          actions={this.actions}
          staticElements={[
            this.mStatus, MOD_ID, MOD_NAME, MOD_VERSION, FILENAME, FILES, LOCAL]}
        />
      );

    const importArchivesWarning: JSX.Element = (importArchives === false)
      ? (
        <p className='import-archives-warning'>
          {t('You will not be able to re-install these mods!')}
        </p>)
      : null;

    return (
      <div className='import-mods-selection'>
        {content}
        <h3>{t(`Importing: ${this.getModNumber()} mods`)}</h3>
        <Toggle
          checked={importArchives}
          onToggle={this.toggleArchiveImport}
          style={{ marginTop: 10 }}
        >
          <a
            className='fake-link'
            title={t('If toggled, this will import the mod archive (7z, zip, rar) in addition to '
            + 'any imported mod.')}
          >
            {t('Import archives')}
          </a>
        </Toggle>
        {importArchivesWarning}
      </div>
    );
  }

  private renderWorking(): JSX.Element {
    const { t } = this.props;
    const { progress, modsToImport } = this.state;
    if (progress === undefined) {
      return null;
    }
    const perc = Math.floor((progress.pos * 100) / Object.keys(modsToImport).length);
    return (
      <div className='import-working-container'>
        <span>
          <h3>
            {t('Mods are being copied. This might take a while. Thank you for your patience.')}
          </h3>
          {t('Currently importing: {{mod}}', {replace: { mod: progress.mod }})}
        </span>
        <ProgressBar now={perc} label={`${perc}%`} />
      </div>
    );
  }

  private hasConflicts(): boolean {
    const { conflictedMods } = this.state;
    const imported: IModEntry[] = this.getSuccessfullyImported();
    if (conflictedMods.length === 0 || imported === undefined || imported.length === 0) {
      return false;
    }

    const conflicted: IModEntry[] =
      imported.filter(mod => conflictedMods.find(conf => conf === mod.modName) !== undefined);
    return conflicted.length > 0 ? true : false;
  }

  private renderEnableModsOnFinishToggle(): JSX.Element {
    const { t, profilesVisible } = this.props;
    const { successfullyImported, enableModsOnFinish } = this.state;

    return successfullyImported.length > 0 ? (
      <div>
        <Toggle
            checked={enableModsOnFinish}
            onToggle={this.toggleEnableOnFinish}
        >
          <a
            className='fake-link'
            title={profilesVisible ? t('Will enable the imported mods for the selected profile')
                                  : t('Enable imported mods.')}
          >
            {profilesVisible
              ? t('If toggled, will enable all imported mods for the selected profile.')
              : t('If toggled, will enable all imported mods.')}
          </a>
        </Toggle>
      </div>
    ) : null;
  }

  private renderReviewSummary(): JSX.Element {
    const { t, profilesVisible, profiles } = this.props;
    const { successfullyImported } = this.state;

    const showProfiles = (profilesVisible
      && (successfullyImported.length > 0)
      && (profiles !== undefined))
        ? this.renderProfiles()
        : null;

    return successfullyImported.length > 0 ? (
      <div>
        {t('Your selected mods have been imported successfully. You can decide now ')}
        {t('whether you would like to enable all imported mods,')} <br/>
        {t('or whether you want your imported mods to remain disabled for now.')}<br/><br/>
        {showProfiles}
        {this.renderEnableModsOnFinishToggle()}
    </div>
    ) : null;
  }

  private renderConflicts() {
    const { t } = this.props;
    const hasConflicts: boolean = this.hasConflicts();

    return (
      hasConflicts ? (
        <div>
          <div className='import-conflict-title'>
            <Icon name='conflict' />
            {t('Mod Conflicts:')}
          </div>

          {t('Vortex has detected unsolved file conflicts. This is not an error and merely implies '
           + 'that you will have to choose which conflicting mods should')} <br/>
          {t('overwrite one another - similar to how you decide on overwrites when installing mods '
           + 'with NMM:')}<br/><br/>
          {this.getLink(_LINKS.FILE_CONFLICTS,
            'I am getting a lot of mod conflicts with Vortex that were not there in Nexus Mod '
           + 'Manager. What’s wrong? ')}<br/><br/>
          {t('Unlike NMM, with Vortex you will be able to change your overwrite decisions '
           + 'dynamically without having to reinstall the mods.')} <br/><br/>
          {t('You can easily address these file conflicts / overwrites with Vortex\'s ')}
          {this.getLink(_LINKS.MANAGE_CONFLICTS, 'built-in conflict resolution tools.')} <br/>
          {t('You can learn more about how to properly address file conflicts and more in ')}
          {this.getLink(_LINKS.DOCUMENTATION, 'our documentation.')}
        </div>
      ) : null
    );
  }

  private renderReview(): JSX.Element {
    const { t } = this.props;
    const { failedImports } = this.state;

    return (
      <div className='import-working-container'>
        {
          failedImports.length === 0
            ? (
              <span className='import-success'>
                <Icon name='feedback-success' /> {t('Import successful')}<br/>
              </span>
            ) : (
              <span className='import-errors'>
                <Icon name='feedback-error' /> {t('There were errors')}
              </span>
            )
        }
        <span className='import-review-text'>
          {t('You can review the log at: ')}
          <a onClick={this.openLog}>{this.mTrace.logFilePath}</a>
        </span><br/><br/>
        <span>
        {this.renderReviewSummary()}
        <br/><br/>
        {this.renderConflicts()}
        <br/><br/>
        </span>
      </div>
    );
  }

  private openLog = (evt) => {
    evt.preventDefault();
    (util as any).opn(this.mTrace.logFilePath).catch(err => undefined);
  }

  private nextLabel(step: Step): string {
    const {t} = this.props;
    switch (step) {
      case 'start': return t('Setup');
      case 'setup': return t('Start Import');
      case 'working': return null;
      case 'review': return t('Finish');
    }
  }

  private selectSource = eventKey => {
    this.nextState.selectedSource = eventKey;
  }

  private selectProfile = eventKey => {
    const { t, activeProfile, profiles } = this.props;
    if (eventKey === '_currently_active_profile_') {
      this.nextState.selectedProfile = { id: activeProfile.id, profile: activeProfile };
    } else if (eventKey === '_create_new_profile_') {
      this.createANewProfile().then(res => {
        if (res !== undefined) {
          this.nextState.selectedProfile = { id: res.id, profile: res };
        } else {
          this.context.api.showErrorNotification(t('Unable to create new profile'), null);
        }
      });
    } else {
      const profList = Object.keys(profiles).map(id => profiles[id]);
      const prof = profList.find(profile => profile.id === eventKey);

      (prof !== undefined)
        ? this.nextState.selectedProfile = { id: prof.id, profile: prof }
        : this.context.api.showErrorNotification(t('Failed to select profile'), null);
    }
  }

  private nop = () => undefined;

  private cancel = () => {
    this.props.onSetStep(undefined);
  }

  private next() {
    const { onSetStep, importStep } = this.props;
    const currentIdx = ImportDialog.STEPS.indexOf(importStep);
    onSetStep(ImportDialog.STEPS[currentIdx + 1]);
  }

  private finish() {
    const { activeProfile, gameId } = this.props;
    const { selectedProfile, enableModsOnFinish, conflictedMods } = this.state;

    // We're only interested in the mods we actually managed to import.
    const imported = this.getSuccessfullyImported();

    // If we did not succeed in importing anything, there's no point in
    //  enabling anything.
    if (imported.length === 0) {
      this.next();
      return;
    }

    const store = this.context.api.store;
    const state = store.getState();

    // Check whether the user wants Vortex to automatically enable the mods
    //  he imported from NMM, and if so, enable the mods for the selected
    //  profile.
    if (enableModsOnFinish) {
      enableModsForProfile(gameId, selectedProfile.id, state, imported, store.dispatch);

      // Check whether the active profile is different from the selected profile.
      //  If so, raise the switch profile notification; otherwise notify the user that
      //  he needs to deploy the newly added mods.
      if (activeProfile.id !== selectedProfile.id) {
        this.notifySwitchProfile();
      } else {
        // Only deploy if we have no conflicts
        if (conflictedMods.length === 0) {
          this.context.api.store.dispatch(actions.setDeploymentNecessary(gameId, true));
        }
      }
    }

    this.next();
  }

  private isIdenticalRootPath(): boolean {
    const { modFiles, archiveFiles } = this.state.capacityInformation;
    if (modFiles.rootPath === archiveFiles.rootPath) {
      return true;
    }
    return false;
  }

  private start() {
    const { modFiles, archiveFiles } = this.nextState.capacityInformation;
    const { activeProfile, downloadPath, installPath } = this.props;
    this.nextState.error = undefined;

    this.nextState.selectedProfile = { id: activeProfile.id, profile: activeProfile };

    try {
      modFiles.rootPath = winapi.GetVolumePathName(installPath);
      archiveFiles.rootPath = winapi.GetVolumePathName(downloadPath);

      // It is beyond the scope of the disk space calculation logic to check or ensure
      //  that the installation/download paths exist (this should've been handled before this
      //  stage);
      //  reason why we're simply going to use the root paths for the calculation.
      //
      //  This is arguably a band-aid fix for https://github.com/Nexus-Mods/Vortex/issues/2624;
      //  but the only reason why these folders would be missing in the first place is if they
      //  have been removed manually or by an external application WHILE Vortex is running!
      //
      //  The import process will create these directories when mod/archive files are copied over
      //  if they're missing.
      modFiles.totalFreeBytes =
        winapi.GetDiskFreeSpaceEx(modFiles.rootPath).free - MIN_DISK_SPACE_OFFSET;
      archiveFiles.totalFreeBytes =
        winapi.GetDiskFreeSpaceEx(archiveFiles.rootPath).free - MIN_DISK_SPACE_OFFSET;
    } catch (err) {
      this.context.api.showErrorNotification('Unable to start import process', err, {
        // don't allow report on "not found" and permission errors
        allowReport: [2, 3, 5].indexOf(err.errno) === -1,
      });
      this.cancel();
    }

    findInstances(this.props.gameId)
      .then(found => {
        this.nextState.sources = found;
        this.nextState.selectedSource = found[0];
      })
      .catch(err => {
        this.nextState.error = err.message;
      });
  }

  private setup() {
    const { gameId } = this.props;
    const virtualPath =
      path.join(this.state.selectedSource[0], 'VirtualInstall', 'VirtualModConfig.xml');
    const state: types.IState = this.context.api.store.getState();
    const mods = state.persistent.mods[gameId] || {};

    return parseNMMConfigFile(virtualPath, mods)
      .then((modEntries: IModEntry[]) => {
        this.nextState.modsToImport = modEntries.reduce((prev, value) => {
          // modfilename appears to be the only field that we can rely on being set and it being
          // unique
          prev[value.modFilename] = value;
          return prev;
        }, {});
      })
      .catch(err => {
        this.nextState.error = err.message;
      }).finally(() => this.onStartUp());
  }

  private modWillBeEnabled(mod: IModEntry): boolean {
    return ((this.nextState.importEnabled[mod.modFilename] !== false) &&
          !((this.nextState.importEnabled[mod.modFilename] === undefined) && mod.isAlreadyManaged));
  }

  private isModEnabled(mod: IModEntry): boolean {
    return ((this.state.importEnabled[mod.modFilename] !== false) &&
          !((this.state.importEnabled[mod.modFilename] === undefined) && mod.isAlreadyManaged));
  }

  private startImport() {
    const { gameId } = this.props;
    const { importArchives, modsToImport, selectedSource } = this.state;

    this.mTrace = new TraceImport();

    const modList = Object.keys(modsToImport).map(id => modsToImport[id]);
    const enabledMods = modList.filter(mod => this.isModEnabled(mod));
    const virtualInstallPath = path.join(selectedSource[0], 'VirtualInstall');
    const nmmLinkPath = (selectedSource[1]) ? path.join(selectedSource[1], gameId, 'NMMLink') : '';
    const modsPath = selectedSource[2];

    // The categories.xml file seems to be created by NMM inside its defined "modFolder"
    //  and not inside the virtual folder.
    const categoriesPath = path.join(modsPath, 'categories', 'Categories.xml');

    this.mTrace.initDirectory(selectedSource[0])
      .then(() => getCategories(categoriesPath))
      // Do not stop the import process just because we can't import categories.
      .catch(err => {
        this.mTrace.log('error', 'Failed to import categories from NMM', err);
        return Promise.resolve({});
      })
      .then(categories => {
        this.mTrace.log('info', 'NMM Mods (count): ' + modList.length +
          ' - Importing (count):' + enabledMods.length);
        this.context.api.events.emit('enable-download-watch', false);
        return importMods(this.context.api, this.mTrace,
          virtualInstallPath, nmmLinkPath, modsPath, enabledMods,
          importArchives, categories, (mod: string, pos: number) => {
            this.nextState.progress = { mod, pos };
          })
          .then(errors => {
            this.context.api.events.emit('enable-download-watch', true);
            this.nextState.failedImports = errors;
            this.props.onSetStep('review');
          });
      })
      .catch(err => {
        this.context.api.events.emit('enable-download-watch', true);
        this.nextState.error = err.message;
      });
  }
}

function mapStateToProps(state: any): IConnectedProps {
  const gameId = selectors.activeGameId(state);
  const profiles: {[id: string]: types.IProfile} =
    util.getSafe(state, ['persistent', 'profiles'], undefined);

  // Worried about how the below bit may affect performance...
  const relevantProfiles: {[id: string]: types.IProfile} = {};
  (profiles !== undefined)
    ? Object.keys(profiles)
      .map(id => profiles[id])
      .filter(prof => prof.gameId === gameId)
      .forEach(profile => relevantProfiles[profile.id] = profile)
    : {};

  return {
    gameId,
    importStep: state.session.modimport.importStep,
    profilesVisible: state.settings.interface.profilesVisible,
    downloadPath: selectors.downloadPath(state),
    installPath: gameId !== undefined ? selectors.installPathForGame(state, gameId) : undefined,
    activeProfile: selectors.activeProfile(state),
    profiles: relevantProfiles,
  };
}

function mapDispatchToProps(dispatch: Redux.Dispatch<any>): IActionProps {
  return {
    onSetStep: (step?: Step) => dispatch(setImportStep(step)),
    onCreateProfile: (profile: types.IProfile) => dispatch(actions.setProfile(profile)),
  };
}

export default withTranslation([ 'common' ])(
  connect(mapStateToProps, mapDispatchToProps)(
    ImportDialog) as any) as React.ComponentClass<{}>;
