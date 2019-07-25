import { setImportStep } from '../actions/session';

import { IModEntry, ParseError } from '../types/nmmEntries';
import { getCategories } from '../util/categories';
import findInstances from '../util/findInstances';
import importArchives from '../util/import';
import parseNMMConfigFile, { isConfigEmpty } from '../util/nmmVirtualConfigParser';

import * as winapi from 'winapi-bindings';
import TraceImport from '../util/TraceImport';

import {
  FILENAME, LOCAL, MOD_ID, MOD_NAME, MOD_VERSION,
} from '../importedModAttributes';

import * as path from 'path';
import * as React from 'react';
import { Alert, Button, MenuItem, ProgressBar, SplitButton, ListGroup, ListGroupItem } from 'react-bootstrap';
import { withTranslation } from 'react-i18next';
import { connect } from 'react-redux';
import * as Redux from 'redux';
import { ComponentEx, EmptyPlaceholder, fs, Icon, ITableRowAction, log, Modal,
         selectors, Spinner, Steps, Table, Toggle, tooltip, types, util } from 'vortex-api';

import { app, remote } from 'electron';
const appUni = app || remote.app;
const IMAGES_FOLDER = path.join(appUni.getAppPath(), 'assets', 'images');

import * as Promise from 'bluebird';

import { createHash } from 'crypto';

type Step = 'start' | 'setup' | 'working' | 'review';

// Used to reduce the amount of detected free space by 500MB.
//  This is done to avoid situations where the user may be left
//  with no disk space after the import process is finished.
const MIN_DISK_SPACE_OFFSET = (500 * (1e+6));

// Set of known/acceptable archive extensions.
const archiveExtLookup = new Set<string>([
  '.zip', '.7z', '.rar', '.bz2', '.bzip2', '.gz', '.gzip', '.xz', '.z',
]);

const _LINKS = {
// tslint:disable-next-line: max-line-length
  TO_CONSIDER: 'https://wiki.nexusmods.com/index.php/Importing_from_Nexus_Mod_Manager:_Things_to_consider',
// tslint:disable-next-line: max-line-length
  UNMANAGED: 'https://wiki.nexusmods.com/index.php/Importing_from_Nexus_Mod_Manager:_Things_to_consider#Unmanaged_Files',
// tslint:disable-next-line: max-line-length
  FILE_CONFLICTS: 'https://wiki.nexusmods.com/index.php/File_Conflicts:_Nexus_Mod_Manager_vs_Vortex',
  MANAGE_CONFLICTS: 'https://wiki.nexusmods.com/index.php/Managing_File_Conflicts',
  DOCUMENTATION: 'https://wiki.nexusmods.com/index.php/Category:Vortex',
};

interface IConnectedProps {
  gameId: string;
  downloadPath: string;
  installPath: string;
  importStep?: Step;
}

interface ICapacityInfo {
  rootPath: string;
  totalNeededBytes: number;
  totalFreeBytes: number;
  hasCalculationErrors: boolean;
}

interface IActionProps {
  onSetStep: (newState: Step) => void;
}

type IProps = IConnectedProps & IActionProps;

interface IComponentState {
  busy: boolean;
  sources: string[][];
  selectedSource: string[];
  modsToImport: { [id: string]: IModEntry };
  parsedMods: { [id: string]: IModEntry };
  error: string;
  importEnabled: { [id: string]: boolean };
  counter: number;
  progress: { mod: string, pos: number };
  failedImports: string[];

  // Dictates whether we can start the import process.
  nmmModsEnabled: boolean;
  nmmRunning: boolean;

  // State of the plugin sorting functionality.
  autoSortEnabled: boolean;

  // Disk space calculation variables.
  capacityInformation: ICapacityInfo;
  modsCapacity: { [id: string]: number };

  // Array of successfully imported mod entries.
  successfullyImported: IModEntry[];

  // Dictates whether the installation process
  //  should be kicked off immediately after the user
  //  has closed the review page.
  installModsOnFinish: boolean;
}

class ImportDialog extends ComponentEx<IProps, IComponentState> {
  private static STEPS: Step[] = [ 'start', 'setup', 'working', 'review' ];

  private mStatus: types.ITableAttribute;
  private mTrace: TraceImport;
  private actions: ITableRowAction[];

  constructor(props: IProps) {
    super(props);

    this.initState({
      busy: false,
      sources: undefined,
      modsToImport: undefined,
      parsedMods: undefined,
      selectedSource: [],
      error: undefined,
      importEnabled: {},
      modsCapacity: {},
      counter: 0,
      progress: undefined,
      failedImports: [],
      nmmModsEnabled: false,
      nmmRunning: false,
      autoSortEnabled: false,

      capacityInformation: {
        rootPath: '',
        totalNeededBytes: 0,
        totalFreeBytes: 0,
        hasCalculationErrors: false,
      },

      installModsOnFinish: false,
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
    const { error, sources, capacityInformation } = this.state;

    const canCancel = ((['start', 'setup'].indexOf(importStep) !== -1)
                   || ((importStep === 'working') && (!this.canImport()))
                   || (error !== undefined));
    const nextLabel = ((sources !== undefined) && (sources.length > 0))
      ? this.nextLabel(importStep)
      : undefined;

    const onClick = () => (importStep !== 'review')
      ? this.next() : this.finish();

    return (
      <Modal id='import-dialog' show={importStep !== undefined} onHide={this.nop}>
        <Modal.Header>
          <Modal.Title>{t('Nexus Mod Manager (NMM) Import Tool')}</Modal.Title>
          {this.renderCurrentStep()}
        </Modal.Header>
        <Modal.Body>
          {
            error !== undefined
              ? <Alert bsStyle='danger'>{error}</Alert>
              : this.renderContent(importStep)
          }
        </Modal.Body>
        <Modal.Footer>
          {importStep === 'setup' && capacityInformation.hasCalculationErrors ? (
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
    this.nextState.modsToImport = undefined;
    this.nextState.parsedMods = undefined;
    this.nextState.selectedSource = [];
    this.nextState.error = undefined;
    this.nextState.importEnabled = {};
    this.nextState.counter = 0;
    this.nextState.progress = undefined;
    this.nextState.failedImports = [];
    this.nextState.capacityInformation = {
        rootPath: '',
        totalNeededBytes: 0,
        totalFreeBytes: 0,
        hasCalculationErrors: false,
    };
    this.nextState.installModsOnFinish = false;
    this.nextState.autoSortEnabled = false;
    this.nextState.successfullyImported = [];
  }

  private canImport() {
    const { nmmModsEnabled, nmmRunning } = this.state;
    return !nmmModsEnabled && !nmmRunning;
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
    const { capacityInformation, modsToImport } = this.nextState;
    const validCalcState = ((modsToImport !== undefined)
                         && (Object.keys(modsToImport).length > 0));
    capacityInformation.hasCalculationErrors = false;
    capacityInformation.totalNeededBytes = validCalcState
      ? this.calcArchiveFiles()
      : 0;
  }

  private getModNumber(): string {
    const { modsToImport } = this.state;
    if (modsToImport === undefined) {
      return undefined;
    }

    const modList = Object.keys(modsToImport).map(id => modsToImport[id]);
    const enabledMods = modList.filter(mod => this.isModEnabled(mod));

    return `${enabledMods.length} / ${modList.length}`;
  }

  private onStartUp(): Promise<void> {
    const { parsedMods } = this.nextState;
    if (parsedMods === undefined) {
      // happens if there are no NMM mods for this game
      return Promise.resolve();
    }

    return this.populateModsTable((mod: string) => {
      this.nextState.progress = { mod, pos: 0 };
    }).then(mods => {
      this.nextState.modsToImport = mods;
      const modList = Object.keys(mods)
      .map(id => mods[id]);

      return this.calculateModsCapacity(modList, (mod: string) => {
        this.nextState.progress = { mod, pos: 0 };
      });
    });
  }

  private calculateModsCapacity(modList: IModEntry[],
                                progress: (mod: string) => void): Promise<void> {
    const { capacityInformation } = this.nextState;
    const modCapacityInfo: { [id: string]: number } = {};
    return Promise.mapSeries(modList, (mod, idx) => {
      progress(mod.modFilename);
      return this.calculateArchiveSize(mod)
      .then(archiveSizeBytes => {
        modCapacityInfo[mod.modFilename] = archiveSizeBytes;
        return Promise.resolve();
      })
      .catch(() => {
        capacityInformation.hasCalculationErrors = true;
        modCapacityInfo[mod.modFilename] = 0;
        return Promise.resolve();
      });
    })
    .then(() => {
      this.nextState.modsCapacity = modCapacityInfo;
      this.recalculate();
      return Promise.resolve();
    });
  }

  private calcArchiveFiles() {
    const { modsCapacity, modsToImport } = this.nextState;
    return Object.keys(modsCapacity)
      .filter(id => this.modWillBeEnabled(modsToImport[id]))
      .map(id => modsCapacity[id])
      .reduce((total, archiveBytes) => total + archiveBytes, 0);
  }

  private calculateArchiveSize(mod: IModEntry): Promise<number> {
    return fs.statAsync(path.join(mod.archivePath, mod.modFilename))
      .then(stats => stats.size)
      .catch(util.UserCanceled, () => Promise.resolve(0));
  }

  // To be used after the import process finished. Will return
  //  an array containing successfully imported archives.
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

  private getCapacityInfo(instance: ICapacityInfo): JSX.Element {
    const { t } = this.props;
    return (
      <div>
          <h3
            className={(instance.totalNeededBytes > instance.totalFreeBytes)
              ? 'disk-space-insufficient'
              : 'disk-space-sufficient'}
          >
            {
            t('{{rootPath}} - Size required: {{required}} / {{available}}', {
              replace: {
                rootPath: instance.rootPath,
                required: instance.hasCalculationErrors
                  ? '???'
                  : util.bytesToString(instance.totalNeededBytes),
                available: util.bytesToString(instance.totalFreeBytes),
              },
            })}
          </h3>
      </div>
    );
  }

  private isNextDisabled = () => {
    const { importStep } = this.props;
    const { error, modsToImport, capacityInformation } = this.state;

    const enabled = (modsToImport !== undefined)
      ? Object.keys(modsToImport).filter(id => this.isModEnabled(modsToImport[id]))
      : [];

    // We don't want to fill up the user's harddrive.
    const totalFree = capacityInformation.totalFreeBytes - MIN_DISK_SPACE_OFFSET;
    const hasSpace = capacityInformation.totalNeededBytes > totalFree;
    return (error !== undefined)
        || ((importStep === 'setup') && (modsToImport === undefined))
        || ((importStep === 'setup') && (enabled.length === 0))
        || ((importStep === 'setup') && (hasSpace));
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
      case 'working': return (this.canImport()) ? this.renderWorking() : this.renderValidation();
      case 'review': return this.renderReview();
      default: return null;
    }
  }

  private renderStart(): JSX.Element {
    const { t } = this.props;
    const { sources, selectedSource } = this.state;

    const positives: string[] = [
      'Copy over all archives found inside the selected NMM installation.',

      'Provide the option to install imported archives at the end of the '
      + 'import process.',

      'Leave your existing NMM installation disabled, but functionally intact.',
    ];

    const negatives: string[] = [
      'Import any mod files in your data folder that are not managed by NMM.',

      'Import your FOMOD options.',

      'Preserve your plugin load order, as plugins will be rearranged according '
      + 'to LOOT rules once enabled.',
    ];

    const renderItem = (text: string, idx: number, positive: boolean): JSX.Element => (
      <div key={idx} className='import-description-item'>
        <Icon name={positive ? 'feedback-success' : 'feedback-error'}/>
        <p>{t(text)}</p>
      </div>
    );

    const renderPositives = (): JSX.Element => (
      <div className='import-description-column import-description-positive'>
        <h4>{t('The import tool will:')}</h4>
        <span>
          {positives.map((positive, idx) => renderItem(positive, idx, true))}
        </span>
      </div>
    );

    const renderNegatives = (): JSX.Element => (
        <div className='import-description-column import-description-negative'>
          <h4>{t('The import tool won’t:')}</h4>
          <span>
            {negatives.map((negative, idx) => renderItem(negative, idx, false))}
          </span>
        </div>
    );

    return (
      <span
        className='import-start-container'
      >
        <div>
          {t('This is an import tool that allows you to bring your mod archives over from an '
          + 'existing NMM installation.')} <br/>
        </div>
        <div className='start-info'>
          {renderPositives()}
          {renderNegatives()}
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
        <br />
        <SplitButton
          id='import-select-source'
          title={selectedSource !== undefined ? selectedSource[0] || '' : ''}
          onSelect={this.selectSource}
        >
          {sources.map(this.renderSource)}
        </SplitButton>
      </div>
    );
  }

  private renderSource = option => {
    return <MenuItem key={option} eventKey={option}>{option[0]}</MenuItem>;
  }

  private toggleInstallOnFinish = () => {
    const { installModsOnFinish } = this.state;
    this.nextState.installModsOnFinish = !installModsOnFinish;
  }

  private renderValidation(): JSX.Element {
    const { t } = this.props;
    const { busy, nmmModsEnabled, nmmRunning } = this.state;
    const content = (
      <div className='is-not-valid'>
        <div className='not-valid-title'>
          <Icon name='input-cancel' />
          <h2>{t('Can\'t continue')}</h2>
        </div>
        <ListGroup>
          {nmmModsEnabled ? (
            <ListGroupItem>
              <h4>{t('Please disable all mods in NMM')}</h4>
              <p>
                {t('NMM and Vortex would interfere with each other if they both '
                  + 'tried to manage the same mods.')}
                {t('You don\'t have to uninstall the mods, just disable them.')}
              </p>
              <img src={`file://${__dirname}/disablenmm.png`} />
            </ListGroupItem>
           ) : null}
           {nmmRunning ? (
             <ListGroupItem>
               <h4>{t('Please close NMM')}</h4>
               <p>
                 {t('NMM needs to be closed during the import process and generally '
                  + 'while Vortex is installing mods otherwise it may interfere.')}
               </p>
             </ListGroupItem>
           ) : null}
        </ListGroup>
        <div className='revalidate-area'>
          <tooltip.IconButton
            id='revalidate-button'
            icon={busy ? 'spinner' : 'refresh'}
            tooltip={busy ? t('Checking') : t('Check again')}
            disabled={busy}
            onClick={this.validate}
          >
            {t('Check again')}
          </tooltip.IconButton>
        </div>
      </div>
    );

    return content;
  }

  private renderSelectMods(): JSX.Element {
    const { t } = this.props;
    const { counter, modsToImport, progress, capacityInformation } = this.state;

    const calcProgress = (!!progress)
      ? (
        <span>
          <h3>
            {t('Calculating required disk space. Thank you for your patience.')}
          </h3>
          {t('Scanning: {{mod}}', {replace: { mod: progress.mod }})}
        </span>
      )
      : (
        <span>
          <h3>
            {t('Processing NMM cache information. Thank you for your patience.')}
          </h3>
          {t('Looking up archives..')}
        </span>
      );

    const content = (modsToImport === undefined)
      ? (
        <div className='status-container'>
            <Icon name='spinner' />
            {calcProgress}
        </div>
      ) : (
        <Table
          tableId='mods-to-import'
          data={modsToImport}
          dataId={counter}
          actions={this.actions}
          staticElements={[
            this.mStatus, MOD_ID, MOD_NAME, MOD_VERSION, FILENAME, LOCAL]}
        />
      );
    const modNumberText = this.getModNumber();
    return (
      <div className='import-mods-selection'>
        {content}
        {(modNumberText !== undefined)
          ? (
              <div>
                <h3>{t(`Importing: ${this.getModNumber()} mods`)}</h3>
                {this.getCapacityInfo(capacityInformation)}
              </div>
            )
          : null}
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
        <EmptyPlaceholder
          icon='folder-download'
          text={t('Importing Mods...')}
          subtext={t('This might take a while, please be patient')}
        />
        {t('Currently importing: {{mod}}', {replace: { mod: progress.mod }})}
        <ProgressBar now={perc} label={`${perc}%`} />
      </div>
    );
  }

  private renderEnableModsOnFinishToggle(): JSX.Element {
    const { t } = this.props;
    const { successfullyImported, installModsOnFinish } = this.state;

    return successfullyImported.length > 0 ? (
      <div>
        <Toggle
            checked={installModsOnFinish}
            onToggle={this.toggleInstallOnFinish}
        >
          {t('Install imported mods')}
        </Toggle>
      </div>
    ) : null;
  }

  private renderReviewSummary(): JSX.Element {
    const { t } = this.props;
    const { successfullyImported } = this.state;

    return successfullyImported.length > 0 ? (
      <div>
        {t('Your selected mod archives have been imported successfully. You can decide now ')}
        {t('whether you would like to start the installation for all imported mods,')} <br/>
        {t('or whether you want to install these yourself at a later time.')}<br/><br/>
        {this.renderEnableModsOnFinishToggle()}
    </div>
    ) : null;
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
      case 'start': return t('Next');
      case 'setup': return t('Start Import');
      case 'working': return null;
      case 'review': return t('Finish');
    }
  }

  private selectSource = eventKey => {
    this.nextState.selectedSource = eventKey;
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
    const { installModsOnFinish } = this.state;

    // We're only interested in the mods we actually managed to import.
    const imported = this.getSuccessfullyImported();

    // If we did not succeed in importing anything, there's no point in
    //  enabling anything.
    if (imported.length === 0) {
      this.next();
      return;
    }

    // Check whether the user wants Vortex to automatically install all imported
    //  mod archives.
    if (installModsOnFinish) {
      this.installMods(imported);
    }

    this.next();
  }

  private installMods(modEntries: IModEntry[]) {
    const state = this.context.api.store.getState();
    const downloads = util.getSafe(state, ['persistent', 'downloads', 'files'], undefined);
    if (downloads === undefined) {
      // We clearly didn't manage to import anything.
      return Promise.reject(new Error('persistent.downloads.files is empty!'));
    }

    const archiveIds = Object.keys(downloads).filter(key =>
      modEntries.find(mod => mod.modFilename === downloads[key].localPath) !== undefined);
    return Promise.each(archiveIds, archiveId => {
      this.context.api.events.emit('start-install-download', archiveId, true);
    });
  }

  private start() {
    const { capacityInformation } = this.nextState;
    const { downloadPath } = this.props;
    this.nextState.error = undefined;

    // Store the initial value of the plugin sorting functionality (if it's even applicable)
    this.nextState.autoSortEnabled = util.getSafe(this.context.api.store.getState(),
      ['settings', 'plugins', 'autosort'], false);

    try {
      capacityInformation.rootPath = winapi.GetVolumePathName(downloadPath);

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
      capacityInformation.totalFreeBytes =
        winapi.GetDiskFreeSpaceEx(capacityInformation.rootPath).free - MIN_DISK_SPACE_OFFSET;
    } catch (err) {
      this.context.api.showErrorNotification('Unable to start import process', err, {
        // don't allow report on "not found" and permission errors
        allowReport: [2, 3, 5].indexOf(err.errno) === -1,
      });
      this.cancel();
    }

    return findInstances(this.props.gameId)
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
      .catch(ParseError, () => Promise.resolve([]))
      .then((modEntries: IModEntry[]) => {
        this.nextState.parsedMods = modEntries.reduce((prev, value) => {
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

  private populateModsTable(progress: (mod: string) => void): Promise<{[id: string]: IModEntry}> {
    const { selectedSource, parsedMods } = this.state;
    const mods: {[id: string]: IModEntry} = {...parsedMods};
    const state = this.context.api.store.getState();
    let existingDownloads: Set<string>;
    const downloads = util.getSafe(state, ['persistent', 'downloads', 'files'], undefined);
    if ((downloads !== undefined) && (Object.keys(downloads).length > 0)) {
      existingDownloads = new Set<string>(
        Object.keys(downloads).map(key => downloads[key].localPath));
    }

    return this.getArchives()
      .then(archives => Promise.map(archives, archive => {
        return this.createModEntry(selectedSource[2], archive, existingDownloads)
          .then(mod => {
            progress(mod.modFilename);
            mods[mod.modFilename] = mod;
            return Promise.resolve();
          });
      }).then(() => mods));
  }

  private fileChecksum(filePath: string): Promise<string> {
    const stackErr = new Error();
    return new Promise<string>((resolve, reject) => {
      try {
        const hash = createHash('md5');
        const stream = fs.createReadStream(filePath);
        stream.on('data', (data) => {
          hash.update(data);
        });
        stream.on('end', () => {
          stream.close();
          stream.destroy();
          return resolve(hash.digest('hex'));
        });
        stream.on('error', (err) => {
          err.stack = stackErr.stack;
          reject(err);
        });
      } catch (err) {
        err.stack = stackErr.stack;
        reject(err);
      }
    });
  }

  private createModEntry(sourcePath: string,
                         input: string,
                         existingDownloads: Set<string>): Promise<IModEntry> {
  // Attempt to query cache/meta information from NMM and return a mod entry
  //  to use in the import process.
  const getInner = (ele: Element): string => {
    if ((ele !== undefined) && (ele !== null)) {
      const node = ele.childNodes[0];
      if (node !== undefined) {
        return node.nodeValue;
      }
    }
    return undefined;
  };

  const isDuplicate = () => {
    return (existingDownloads !== undefined)
      ? existingDownloads.has(input)
      : false;
  };

  const id = path.basename(input, path.extname(input));
  const cacheBasePath = path.resolve(sourcePath, 'cache', id);
  return this.fileChecksum(path.join(sourcePath, input))
    .then(md5 => fs.readFileAsync(path.join(cacheBasePath, 'cacheInfo.txt'))
      .then(data => {
        const fields = data.toString().split('@@');
        return fs.readFileAsync(path.join(cacheBasePath,
          (fields[1] === '-') ? '' : fields[1], 'fomod', 'info.xml'));
      })
      .then(infoXmlData => {
        const parser = new DOMParser();
        const xmlDoc = parser.parseFromString(infoXmlData.toString(), 'text/xml');
        const modName = getInner(xmlDoc.querySelector('Name')) || id;
        const version = getInner(xmlDoc.querySelector('Version')) || '';
        const modId = getInner(xmlDoc.querySelector('Id')) || '';
        const downloadId = () => {
          try {
            return Number.parseInt(getInner(xmlDoc.querySelector('DownloadId')), 10);
          } catch (err) {
            return 0;
          }
        };

        return Promise.resolve({
          nexusId: modId,
          vortexId: '',
          downloadId: downloadId(),
          modName,
          modFilename: input,
          archivePath: sourcePath,
          modVersion: version,
          archiveMD5: md5,
          importFlag: true,
          isAlreadyManaged: isDuplicate(),
        });
      })
      .catch(err => {
        log('error', 'could not parse the mod\'s cache information', err);
        return Promise.resolve({
          nexusId: '',
          vortexId: '',
          downloadId: 0,
          modName: path.basename(input, path.extname(input)),
          modFilename: input,
          archivePath: sourcePath,
          modVersion: '',
          archiveMD5: md5,
          importFlag: true,
          isAlreadyManaged: isDuplicate(),
        });
    }));
}

  private getArchives() {
    const { selectedSource, parsedMods } = this.state;
    const knownArchiveExt = (filePath: string): boolean => (!!filePath)
      ? archiveExtLookup.has(path.extname(filePath).toLowerCase())
      : false;

    // Set of mod files which we already have meta information on.
    const modFileNames = new Set<string>(Object.keys(parsedMods)
      .map(key => parsedMods[key].modFilename));

    return fs.readdirAsync(selectedSource[2])
      .filter(filePath => knownArchiveExt(filePath))
      .then(archives => archives.filter(archive => !modFileNames.has(archive)))
      .catch(err => {
        this.nextState.error = err.message;
        return [];
      });
  }

  private isNMMRunning(): boolean {
    const processes = winapi.GetProcessList();
    const runningExes: { [exeId: string]: winapi.ProcessEntry } =
      processes.reduce((prev, entry) => {
        prev[entry.exeFile.toLowerCase()] = entry;
        return prev;
      }, {});

    return Object.keys(runningExes).find(key => key === 'nexusclient.exe') !== undefined;
  }

  private validate = () => {
    const { selectedSource } = this.state;
    this.nextState.busy = true;
    isConfigEmpty(path.join(selectedSource[0], 'VirtualInstall', 'VirtualModConfig.xml'))
      .then(res => {
        this.nextState.nmmModsEnabled = !res;
        this.nextState.nmmRunning = this.isNMMRunning();
        this.nextState.busy = false;
      });
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
    const { autoSortEnabled, modsToImport, selectedSource } = this.state;

    if (autoSortEnabled) {
      // We don't want the sorting functionality to kick off as the user
      //  is removing plugins through NMM with Vortex open.
      this.context.api.events.emit('autosort-plugins', false);
    }

    const startImportProcess = (): Promise<void> => {
      if (autoSortEnabled) {
        // If we're able to start the import process, then clearly
        //  the user had already disabled the mods through NMM
        //  should be safe to turn autosort back on.
        this.context.api.events.emit('autosort-plugins', true);
      }

      this.mTrace = new TraceImport();
      const modList = Object.keys(modsToImport).map(id => modsToImport[id]);
      const enabledMods = modList.filter(mod => this.isModEnabled(mod));
      const modsPath = selectedSource[2];
      this.mTrace.initDirectory(selectedSource[0]);
      // The categories.xml file seems to be created by NMM inside its defined "modFolder"
      //  and not inside the virtual folder.
      const categoriesPath = path.join(modsPath, 'categories', 'Categories.xml');
      return getCategories(categoriesPath)
        .catch(err => {
          // Do not stop the import process just because we can't import categories.
          this.mTrace.log('error', 'Failed to import categories from NMM', err);
          return Promise.resolve({});
        })
        .then(categories => {
          this.mTrace.log('info', 'NMM Mods (count): ' + modList.length +
            ' - Importing (count):' + enabledMods.length);
          this.context.api.events.emit('enable-download-watch', false);

          return importArchives(this.context.api, gameId, this.mTrace, modsPath, enabledMods,
            categories, (mod: string, pos: number) => {
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
    };

    const validateLoop = () => this.canImport()
      ? startImportProcess()
      : setTimeout(() => validateLoop(), 2000);

    this.nextState.busy = true;
    return isConfigEmpty(path.join(selectedSource[0], 'VirtualInstall', 'VirtualModConfig.xml'))
      .then(res => {
        this.nextState.nmmModsEnabled = !res;
        this.nextState.nmmRunning = this.isNMMRunning();
        this.nextState.busy = false;
      }).then(() => validateLoop());
  }
}

function mapStateToProps(state: any): IConnectedProps {
  const gameId = selectors.activeGameId(state);

  return {
    gameId,
    importStep: state.session.modimport.importStep,
    downloadPath: selectors.downloadPath(state),
    installPath: gameId !== undefined ? selectors.installPathForGame(state, gameId) : undefined,
  };
}

function mapDispatchToProps(dispatch: Redux.Dispatch<any>): IActionProps {
  return {
    onSetStep: (step?: Step) => dispatch(setImportStep(step)),
  };
}

export default withTranslation([ 'common' ])(
  connect(mapStateToProps, mapDispatchToProps)(
    ImportDialog) as any) as React.ComponentClass<{}>;
