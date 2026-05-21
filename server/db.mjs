import * as sqlite from "./db-sqlite.mjs";
import * as mssql from "./db-mssql.mjs";

function backend() {
  return process.env.MSSQL_SERVER?.trim() ? mssql : sqlite;
}

/** On-disk folder for legacy JSON migration (SQLite file also lives under `server/data/`). */
export const DATA_DIR = sqlite.DATA_DIR;

export async function ensureDb() {
  return backend().ensureDb();
}

export function isDatabaseLoaded() {
  return backend().isDatabaseLoaded?.() ?? false;
}

export function getDbInfo() {
  return backend().getDbInfo();
}

export async function listManualElectionsMeta() {
  return backend().listManualElectionsMeta();
}

export async function getManualElectionJsonById(id) {
  return backend().getManualElectionJsonById(id);
}

export async function insertManualElection(id, label, electionFileObj) {
  return backend().insertManualElection(id, label, electionFileObj);
}

export async function deleteManualElection(id) {
  return backend().deleteManualElection(id);
}

export async function manualElectionExists(id) {
  return backend().manualElectionExists(id);
}

export async function updateManualElection(id, label, electionFileObj) {
  return backend().updateManualElection(id, label, electionFileObj);
}

export async function listDbTablesWithCounts() {
  return backend().listDbTablesWithCounts();
}

export async function getDbTablePreview(tableName, limit) {
  return backend().getDbTablePreview(tableName, limit);
}

export async function insertSosResultSnapshot(row) {
  return backend().insertSosResultSnapshot(row);
}

export async function insertCountyResultRows(payload) {
  return backend().insertCountyResultRows(payload);
}

export async function commitCountyResultsBatch(payload) {
  return backend().commitCountyResultsBatch(payload);
}

export async function getAppSettings() {
  return backend().getAppSettings();
}

export async function updateAppSettings(settings) {
  return backend().updateAppSettings(settings);
}

export async function getLatestCountyRows(electionId) {
  return backend().getLatestCountyRows(electionId);
}

export async function getSd4MergePreferCountyFeedNameSet(electionId) {
  return backend().getSd4MergePreferCountyFeedNameSet(electionId);
}

export async function listCountySosRaceLinks(electionId) {
  return backend().listCountySosRaceLinks(electionId);
}

export async function upsertCountySosRaceLink(electionId, link) {
  return backend().upsertCountySosRaceLink(electionId, link);
}

export async function deleteCountySosRaceLink(electionId, countyKey, countyContestName) {
  return backend().deleteCountySosRaceLink(electionId, countyKey, countyContestName);
}

export async function listCountySosManualVotes(electionId) {
  return backend().listCountySosManualVotes(electionId);
}

export async function upsertCountySosManualVote(electionId, row) {
  return backend().upsertCountySosManualVote(electionId, row);
}

export async function listCountySosRaceVoteSources(electionId) {
  return backend().listCountySosRaceVoteSources(electionId);
}

export async function upsertCountySosRaceVoteSource(electionId, row) {
  return backend().upsertCountySosRaceVoteSource(electionId, row);
}

export async function buildCivixNameToCountyKeyMap(electionId) {
  return backend().buildCivixNameToCountyKeyMap(electionId);
}

export async function insertSosCandidateRows(payload) {
  return backend().insertSosCandidateRows(payload);
}

export async function insertSosCountyRows(payload) {
  return backend().insertSosCountyRows(payload);
}

export async function getLatestSosCountyRows(electionId) {
  return backend().getLatestSosCountyRows(electionId);
}

export async function clearLiveResultTables() {
  return backend().clearLiveResultTables();
}

export async function pruneLiveResultHistory(keepSosBatches) {
  return backend().pruneLiveResultHistory(keepSosBatches);
}

export async function listElectionSourceConfigs() {
  return backend().listElectionSourceConfigs();
}

export async function getElectionSourceConfig(electionId) {
  return backend().getElectionSourceConfig(electionId);
}

export async function upsertElectionSourceConfig(payload) {
  return backend().upsertElectionSourceConfig(payload);
}

export async function setDefaultElectionCatalog(electionId) {
  return backend().setDefaultElectionCatalog(electionId);
}

export async function listIngestVendors() {
  return backend().listIngestVendors();
}

export async function listElectionFeedSources(electionId) {
  return backend().listElectionFeedSources(electionId);
}

export async function replaceElectionFeedSourcesForElection(electionId, sources) {
  return backend().replaceElectionFeedSourcesForElection(electionId, sources);
}

export async function flushPendingDatabasePersist() {
  const fn = backend().flushPendingDatabasePersist;
  return typeof fn === "function" ? fn() : true;
}

export async function updateElectionFeedSourceUrl(electionId, feedId, sourceUrl) {
  return backend().updateElectionFeedSourceUrl(electionId, feedId, sourceUrl);
}

export async function ensureElectionFeedsSeededFromLegacyForElection(electionId) {
  return backend().ensureElectionFeedsSeededFromLegacyForElection(electionId);
}

export async function appendVoteHistoryIfChanged(payload) {
  return backend().appendVoteHistoryIfChanged(payload);
}

export async function appendSourceImportLog(payload) {
  return backend().appendSourceImportLog(payload);
}

export async function getSourceImportLogPayload(opts) {
  return backend().getSourceImportLogPayload(opts);
}

export async function listEvRosterConfigs() {
  return backend().listEvRosterConfigs();
}

export async function upsertEvRosterConfig(payload) {
  return backend().upsertEvRosterConfig(payload);
}

export async function saveEvRosterPull(payload, options) {
  return backend().saveEvRosterPull(payload, options);
}

export async function mergeEvRosterPull(payload) {
  return backend().mergeEvRosterPull(payload);
}

export async function dedupeEvRosterVotersKeepOldestDate(evrElectionId) {
  return backend().dedupeEvRosterVotersKeepOldestDate(evrElectionId);
}

export async function rebuildEvRosterSummaryCacheForElection(evrElectionId) {
  return backend().rebuildEvRosterSummaryCacheForElection(evrElectionId);
}

export async function clearEvRosterPullData() {
  return backend().clearEvRosterPullData();
}

export async function listEvRosterVoters(evrElectionId, votingDate, options) {
  return backend().listEvRosterVoters(evrElectionId, votingDate, options);
}

export async function listEvRosterPullDates(evrElectionId) {
  return backend().listEvRosterPullDates(evrElectionId);
}

export async function listEvRosterPullDatesForElections(evrElectionIds) {
  return backend().listEvRosterPullDatesForElections(evrElectionIds);
}

export async function listEvRosterVoterDatesForElections(evrElectionIds) {
  return backend().listEvRosterVoterDatesForElections(evrElectionIds);
}

export async function getEvRosterAggregatedSummary(evrElectionIds, dateFrom, dateTo) {
  return backend().getEvRosterAggregatedSummary(evrElectionIds, dateFrom, dateTo);
}

export async function getEvRosterPullPayload(evrElectionId, votingDate) {
  return backend().getEvRosterPullPayload(evrElectionId, votingDate);
}

export async function listEvRosterCountySources(evrElectionId) {
  return backend().listEvRosterCountySources(evrElectionId);
}

export async function upsertEvRosterCountySource(row) {
  return backend().upsertEvRosterCountySource(row);
}

export async function syncEvRosterCountySourcesFromTurnout(evrElectionId, counties) {
  return backend().syncEvRosterCountySourcesFromTurnout(evrElectionId, counties);
}

export async function getEvRosterExportRows(evrElectionId, votingDate) {
  return backend().getEvRosterExportRows(evrElectionId, votingDate);
}

export async function getEvRosterCountyPullLog(evrElectionId, votingDate) {
  return backend().getEvRosterCountyPullLog(evrElectionId, votingDate);
}

export async function getConfirmedEvRosterCountyNames(evrElectionId, votingDate) {
  return backend().getConfirmedEvRosterCountyNames(evrElectionId, votingDate);
}

export async function recordEvRosterCountyPullResults(evrElectionId, votingDate, countyPullLog) {
  return backend().recordEvRosterCountyPullResults(evrElectionId, votingDate, countyPullLog);
}

export async function confirmEvRosterCountyPull(evrElectionId, votingDate, countyName) {
  return backend().confirmEvRosterCountyPull(evrElectionId, votingDate, countyName);
}
