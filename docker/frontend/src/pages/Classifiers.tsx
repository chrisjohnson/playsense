import { useState, useEffect, useCallback, useRef } from 'react';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import TextField from '@mui/material/TextField';
import MenuItem from '@mui/material/MenuItem';
import Button from '@mui/material/Button';
import Chip from '@mui/material/Chip';
import Tooltip from '@mui/material/Tooltip';
import Alert from '@mui/material/Alert';
import LinearProgress from '@mui/material/LinearProgress';
import CircularProgress from '@mui/material/CircularProgress';
import Table from '@mui/material/Table';
import TableBody from '@mui/material/TableBody';
import TableCell from '@mui/material/TableCell';
import TableContainer from '@mui/material/TableContainer';
import TableHead from '@mui/material/TableHead';
import TableRow from '@mui/material/TableRow';
import Dialog from '@mui/material/Dialog';
import DialogTitle from '@mui/material/DialogTitle';
import DialogContent from '@mui/material/DialogContent';
import DialogActions from '@mui/material/DialogActions';
import Divider from '@mui/material/Divider';
import IconButton from '@mui/material/IconButton';
import AddIcon from '@mui/icons-material/Add';
import PlayArrowIcon from '@mui/icons-material/PlayArrow';
import StopIcon from '@mui/icons-material/Stop';
import SmartToyIcon from '@mui/icons-material/SmartToy';
import RefreshIcon from '@mui/icons-material/Refresh';
import EditIcon from '@mui/icons-material/Edit';
import CloseIcon from '@mui/icons-material/Close';
import CheckCircleIcon from '@mui/icons-material/CheckCircle';
import CancelIcon from '@mui/icons-material/Cancel';
import SearchIcon from '@mui/icons-material/Search';
import ShuffleIcon from '@mui/icons-material/Shuffle';

import { api, Classifier, ClassifierJob } from '../api';
import { PulseDot, PageHeader, SectionLabel, DataTable } from '../components';

type PulseState = 'running' | 'queued' | 'retrying' | 'error' | 'done' | 'idle';
const statusPulse: Record<string, PulseState> = {
  queued: 'queued', running: 'running', cancelling: 'retrying',
  retrying: 'retrying', failed: 'error',
  done: 'done', error: 'error', cancelled: 'idle',
};

function fmtDur(s: number): string {
  s = Math.max(0, Math.round(s));
  if (s < 60) return s + 's';
  if (s < 3600) return Math.floor(s / 60) + 'm ' + (s % 60) + 's';
  return Math.floor(s / 3600) + 'h ' + Math.floor((s % 3600) / 60) + 'm';
}

function elapsed(j: ClassifierJob, now?: number): string {
  const start = j.started_at ? new Date(j.started_at).getTime() : (j.created_at ? new Date(j.created_at).getTime() : 0);
  const end = j.finished_at ? new Date(j.finished_at).getTime() : (now ?? Date.now());
  if (!start) return '—';
  return fmtDur((end - start) / 1000);
}

// ETA from the job's current pace - only shown once a little work has
// landed (a 30s warm-up) so the number isn't pure noise at the start.
function etaText(j: ClassifierJob, now: number): string {
  const st = j.state || j.status;
  if (st !== 'running' || !j.started_at || j.done <= 0 || j.total <= j.done) return '';
  const secs = (now - new Date(j.started_at).getTime()) / 1000;
  if (secs < 30) return '';
  const left = ((j.total - j.done) / j.done) * secs;
  if (left < 5) return '';
  return ' · ≈ ' + fmtDur(left) + ' left';
}

type PreviewTrack = {
  id: number;
  name: string;
  artists: string[];
  album_name?: string | null;
  release_date?: string | null;
};

type PreviewResult = {
  track_id: number;
  name: string;
  artists: string[];
  value: any;
  value_ok: boolean;
  reason: string;
};

const PREVIEW_MAX = 50;

function trackLabel(t: { name: string; artists?: string[]; album_name?: string | null }): string {
  const artists = (t.artists || []).join(', ');
  return t.name + (artists ? ' — ' + artists : '') + (t.album_name ? ' (' + t.album_name + ')' : '');
}

function valueCell(v: any, ok: boolean) {
  if (!ok) return <Chip size="small" label="unparsed" color="warning" />;
  if (v === true) return <CheckCircleIcon fontSize="small" color="success" />;
  if (v === false) return <CancelIcon fontSize="small" color="disabled" />;
  return <Typography variant="body2">{typeof v === 'object' ? JSON.stringify(v) : String(v)}</Typography>;
}

function ClassifierModal({ mode, classifier, onClose, onSaved }: {
  mode: 'create' | 'edit';
  classifier?: Classifier;
  onClose: () => void;
  onSaved: (msg: string) => void;
}) {
  const isEdit = mode === 'edit' && !!classifier;
  const [name, setName] = useState(isEdit ? classifier!.name : '');
  const [query, setQuery] = useState(isEdit ? classifier!.query : '');
  const [fieldType, setFieldType] = useState(isEdit ? (classifier!.field_type || '') : '');
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState('');

  const [sel, setSel] = useState<PreviewTrack[]>([]);
  const [q, setQ] = useState('');
  const [matches, setMatches] = useState<PreviewTrack[]>([]);
  const [searching, setSearching] = useState(false);
  const [adding, setAdding] = useState(false);
  const [preview, setPreview] = useState<any | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [previewError, setPreviewError] = useState('');
  const reqRef = useRef(0);
  // Incremental preview cache: results are valid for an exact (query, field
  // type) pair. Re-running with the same definition only sends the tracks
  // added since the last run to the LLM - the rest are served from cache.
  const cacheRef = useRef<{ key: string; field_type: string | null; inferred: boolean; byId: Record<number, any> } | null>(null);
  const keyOf = (qq: string, ft: string) => qq.trim() + '\u0000' + ft;
  const curKey = keyOf(query, fieldType || '');
  const cache = cacheRef.current && cacheRef.current.key === curKey ? cacheRef.current : null;
  const newCount = sel.filter((t) => !cache || cache.byId[t.id] === undefined).length;

  // debounced picker search (250ms), stale responses dropped
  useEffect(() => {
    const s = q.trim();
    if (s.length < 2) { setMatches([]); setSearching(false); return; }
    setSearching(true);
    const id = ++reqRef.current;
    const t = setTimeout(async () => {
      try {
        const r: any = await api.searchTracksForPreview(s, 8);
        if (id !== reqRef.current) return;
        const list: PreviewTrack[] = r?.tracks || [];
        setMatches(list.filter((m) => !sel.some((x) => x.id === m.id)));
      } catch {
        if (id === reqRef.current) setMatches([]);
      } finally {
        if (id === reqRef.current) setSearching(false);
      }
    }, 250);
    return () => clearTimeout(t);
  }, [q, sel]);

  const addTrack = (t: PreviewTrack) => {
    setSel((prev) => (prev.some((x) => x.id === t.id) || prev.length >= PREVIEW_MAX ? prev : [...prev, t]));
    setQ('');
  };
  const removeTrack = (id: number) => setSel((prev) => prev.filter((x) => x.id !== id));

  const addRandom = async () => {
    setAdding(true);
    try {
      const r: any = await api.randomTracksForPreview(20);
      const list: PreviewTrack[] = r?.tracks || [];
      setSel((prev) => {
        const have = new Set(prev.map((x) => x.id));
        return [...prev, ...list.filter((t) => !have.has(t.id))].slice(0, PREVIEW_MAX);
      });
    } catch (e: any) { setFormError(e?.message || String(e)); }
    finally { setAdding(false); }
  };

  const runPreview = async () => {
    if (!query.trim() || sel.length === 0) return;
    setPreviewing(true); setPreviewError('');
    try {
      const byId: Record<number, any> = cache ? { ...cache.byId } : {};
      const missing = sel.filter((t) => byId[t.id] === undefined);
      let r: any = { field_type: null, inferred: false, results: [], chunks: 0, elapsed_ms: 0 };
      if (missing.length > 0) {
        r = await api.previewClassifier({
          query: query.trim(),
          field_type: fieldType || null,
          track_ids: missing.map((t) => t.id),
        });
        for (const res of r.results || []) byId[res.track_id] = res;
        cacheRef.current = { key: curKey, field_type: r.field_type, inferred: !!r.inferred, byId };
      }
      const results = sel.map((t) => byId[t.id]).filter(Boolean);
      setPreview({
        query: query.trim(),
        field_type: r.field_type ?? (cache ? cache.field_type : null),
        inferred: missing.length > 0 ? !!r.inferred : !!(cache && cache.inferred),
        results,
        from_cache: results.length - (missing.length > 0 ? (r.results || []).length : 0),
        elapsed_ms: r.elapsed_ms,
      });
    } catch (e: any) { setPreviewError(e?.message || String(e)); }
    finally { setPreviewing(false); }
  };

  const stats = isEdit ? classifier!.stats : undefined;
  const hasValues = !!stats && (stats.current + stats.stale) > 0;
  const redefined = isEdit && (query.trim() !== classifier!.query || (fieldType !== '' && fieldType !== (classifier!.field_type || '')));
  const willRerun = hasValues && redefined;

  const save = async () => {
    if (!name.trim() || !query.trim()) { setFormError('Name and definition are required.'); return; }
    setSaving(true); setFormError('');
    try {
      if (isEdit) {
        const body: { name?: string; query?: string; field_type?: string } = {};
        if (name.trim() !== classifier!.name) body.name = name.trim();
        if (query.trim() !== classifier!.query) body.query = query.trim();
        if (fieldType !== (classifier!.field_type || '')) body.field_type = fieldType;
        await api.updateClassifier(classifier!.id, body);
        onSaved('Saved "' + name.trim() + '"' + (willRerun
          ? ' — definition changed: all ' + (stats!.current + stats!.stale).toLocaleString() + ' stored values are now stale and will be re-classified automatically.'
          : '.'));
      } else {
        await api.createClassifier({ name: name.trim(), query: query.trim(), ...(fieldType ? { field_type: fieldType } : {}) });
        onSaved('Classifier "' + name.trim() + '" created — the job manager will pick it up automatically.');
      }
      onClose();
    } catch (e: any) { setFormError(e?.message || String(e)); }
    finally { setSaving(false); }
  };

  return (
    <Dialog open onClose={onClose} fullWidth maxWidth="md">
      <DialogTitle sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
        <SmartToyIcon fontSize="medium" />
        <span>{isEdit ? 'Edit classifier — ' + classifier!.name : 'New classifier'}</span>
        <Box sx={{ flexGrow: 1 }} />
        <IconButton onClick={onClose} aria-label="close dialog"><CloseIcon /></IconButton>
      </DialogTitle>
      <DialogContent dividers>
        <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
          <Box sx={{ display: 'flex', gap: 1.5 }}>
            <TextField size="small" label="Name" value={name} onChange={(e) => setName(e.target.value)} sx={{ width: 220 }}
              inputProps={{ 'aria-label': 'classifier name' }} />
            <TextField size="small" select label="Field type" value={fieldType}
              SelectProps={{ displayEmpty: true }}
              onChange={(e) => setFieldType(e.target.value)} sx={{ width: 200 }}>
              {(isEdit && classifier!.field_type) ? null : <MenuItem value="">Auto (LLM infers)</MenuItem>}
              <MenuItem value="boolean">boolean</MenuItem>
              <MenuItem value="string">string</MenuItem>
              <MenuItem value="number">number</MenuItem>
              <MenuItem value="datetime">datetime</MenuItem>
            </TextField>
          </Box>
          <TextField size="small" label="Definition (what the LLM is asked per track)" multiline minRows={2}
            value={query} onChange={(e) => setQuery(e.target.value)}
            inputProps={{ 'aria-label': 'classifier definition' }} />
          {willRerun ? (
            <Alert severity="warning" sx={{ py: 0.5 }}>
              This redefines the classifier — all {(stats!.current + stats!.stale).toLocaleString()} stored values will be
              marked stale and re-classified automatically (a job appears in the table below).
            </Alert>
          ) : null}

          <Divider sx={{ my: 0.5 }}>
            <Typography variant="caption" color="text.secondary">
              Preview — try it on a few tracks first (calls the model; nothing is saved)
            </Typography>
          </Divider>

          <Box>
            <Typography variant="caption" color="text.secondary">{sel.length} / {PREVIEW_MAX} tracks selected</Typography>
            {sel.length > 0 ? (
              <Box sx={{ border: 1, borderColor: 'divider', borderRadius: 1, p: 0.5, mt: 0.5, maxHeight: 140, overflow: 'auto' }}>
                {sel.map((t) => (
                  <Box key={t.id} sx={{ display: 'flex', alignItems: 'center', gap: 0.5, py: 0.25 }}>
                    <Typography variant="body2" noWrap sx={{ flexGrow: 1 }}>{trackLabel(t)}</Typography>
                    <IconButton size="small" onClick={() => removeTrack(t.id)} aria-label={'remove ' + t.name}>
                      <CloseIcon fontSize="inherit" />
                    </IconButton>
                  </Box>
                ))}
              </Box>
            ) : (
              <Typography variant="caption" color="text.secondary" sx={{ mt: 0.5, display: 'block' }}>
                Add tracks below (search or random) to preview this definition.
              </Typography>
            )}
          </Box>

          <Box sx={{ display: 'flex', gap: 1, alignItems: 'flex-start' }}>
            <TextField size="small" placeholder="Search tracks (title, artist, album)…" value={q}
              onChange={(e) => setQ(e.target.value)} sx={{ flexGrow: 1 }}
              InputProps={{ startAdornment: <SearchIcon fontSize="small" sx={{ ml: 1, opacity: 0.5 }} /> }}
              inputProps={{ 'aria-label': 'search tracks for preview' }} />
            <Button size="small" variant="outlined" startIcon={<ShuffleIcon />} onClick={addRandom}
              disabled={adding || sel.length >= PREVIEW_MAX}>
              Add 20 random
            </Button>
          </Box>
          {matches.length > 0 ? (
            <Box sx={{ border: 1, borderColor: 'divider', borderRadius: 1, p: 0.5 }}>
              {matches.map((t) => (
                <Box key={t.id} sx={{ display: 'flex', alignItems: 'center', gap: 0.5, py: 0.25 }}>
                  <Typography variant="body2" noWrap sx={{ flexGrow: 1 }}>{trackLabel(t)}</Typography>
                  <Button size="small" onClick={() => addTrack(t)} disabled={sel.length >= PREVIEW_MAX}>add</Button>
                </Box>
              ))}
            </Box>
          ) : searching ? (
            <Typography variant="caption" color="text.secondary">searching…</Typography>
          ) : null}

          <Box sx={{ display: 'flex', gap: 1, alignItems: 'center' }}>
            <Button variant="contained" size="small" startIcon={<PlayArrowIcon />} onClick={runPreview}
              disabled={!query.trim() || sel.length === 0 || previewing}>
              {previewing ? 'Classifying…'
                : newCount === sel.length ? 'Run preview on ' + sel.length + ' track' + (sel.length === 1 ? '' : 's')
                  : newCount === 0 ? 'All ' + sel.length + ' cached — instant'
                    : 'Check ' + newCount + ' new (' + (sel.length - newCount) + ' cached)'}
            </Button>
            {preview ? (
              <Typography variant="caption" color="text.secondary">
                {preview.results.length} results{preview.from_cache ? ' · ' + preview.from_cache + ' cached' : ''} · type {preview.field_type}{preview.inferred ? ' (inferred)' : ''}{preview.elapsed_ms ? ' · ' + (preview.elapsed_ms / 1000).toFixed(1) + 's' : ''}
              </Typography>
            ) : null}
            {preview && !previewing && preview.query !== query.trim() ? (
              <Typography variant="caption" color="warning" sx={{ display: 'block', mt: 0.5 }}>
                Results below are for a previous version of this definition — re-run to refresh.
              </Typography>
            ) : null}
          </Box>
          {previewError ? <Alert severity="error" onClose={() => setPreviewError('')}>{previewError}</Alert> : null}
          {previewing ? (
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5, py: 1 }}>
              <CircularProgress size={18} />
              <Typography variant="body2">{newCount === 0 ? 'Merging cached results…' : 'Asking the model — up to a minute for ' + newCount + ' new track' + (newCount === 1 ? '' : 's') + (sel.length - newCount > 0 ? ' (' + (sel.length - newCount) + ' from cache)' : '') + '…'}</Typography>
            </Box>
          ) : null}
          {preview && preview.results && preview.results.length > 0 ? (
            <Table size="small">
              <TableHead>
                <TableRow>
                  <TableCell>Track</TableCell>
                  <TableCell sx={{ width: 90 }}>Value</TableCell>
                  <TableCell>Why</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {preview.results.map((r: PreviewResult) => (
                  <TableRow key={r.track_id}>
                    <TableCell><Typography variant="body2" noWrap sx={{ maxWidth: 300 }}>{trackLabel(r)}</Typography></TableCell>
                    <TableCell>{valueCell(r.value, r.value_ok)}</TableCell>
                    <TableCell><Typography variant="caption" color="text.secondary">{r.reason || '—'}</Typography></TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          ) : null}
        </Box>
      </DialogContent>
      <DialogActions sx={{ px: 3, py: 2 }}>
        {formError ? <Typography variant="caption" color="error" sx={{ mr: 'auto' }}>{formError}</Typography> : null}
        <Button onClick={onClose}>Cancel</Button>
        <Button variant="contained" onClick={save} disabled={saving}>
          {saving ? <CircularProgress size={16} color="inherit" /> : (isEdit ? 'Save changes' : 'Create')}
        </Button>
      </DialogActions>
    </Dialog>
  );
}

export default function Classifiers() {
  const [classifiers, setClassifiers] = useState<Classifier[]>([]);
  const [jobs, setJobs] = useState<ClassifierJob[]>([]);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [loading, setLoading] = useState(true);
  const [modal, setModal] = useState<null | { mode: 'create' } | { mode: 'edit'; classifier: Classifier }>(null);

  const refresh = useCallback(() => {
    Promise.all([api.classifiers(), api.classifierJobs()])
      .then(([c, j]: [Classifier[], ClassifierJob[]]) => {
        setClassifiers(Array.isArray(c) ? c : []);
        setJobs(Array.isArray(j) ? j : []);
      })
      .catch((e: any) => setError(e?.message || String(e)))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  // Poll while the tab is open: jobs can appear on their own (auto-scan), and
  // the list is tiny - two small GETs every 8s is negligible.
  useEffect(() => {
    const iv = setInterval(refresh, 8000);
    return () => clearInterval(iv);
  }, [refresh]);

  // 1-second ticker while any job is live: elapsed time should count up
  // smoothly instead of jumping in 8s poll steps.
  const [now, setNow] = useState<number>(() => Date.now());
  const hasLive = jobs.some((j) => {
    const st = j.state || j.status;
    return st === 'running' || st === 'retrying' || st === 'cancelling' || st === 'queued';
  });
  useEffect(() => {
    if (!hasLive) return;
    const iv = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(iv);
  }, [hasLive]);

  const enqueueAll = async (cid: number) => {
    setError('');
    try {
      const r: any = await api.enqueueClassifierJob({ classifier_id: cid });
      let msg = 'Enqueued ' + (r.created?.length ?? 0) + ' job(s)';
      if (r.no_work_playlists?.length) msg += ' - ' + r.no_work_playlists.length + ' playlist(s) have no work yet (empty or fully classified)';
      setNotice(msg);
      refresh();
    } catch (e: any) { setError(e?.message || String(e)); }
  };

  const retry = async (jid: number) => {
    setError('');
    try { await api.retryClassifierJob(jid); refresh(); }
    catch (e: any) { setError(e?.message || String(e)); }
  };

  const cancel = async (jid: number) => {
    setError('');
    try { await api.cancelClassifierJob(jid); refresh(); }
    catch (e: any) { setError(e?.message || String(e)); }
  };

  // Resume a 'partial' job: re-enqueue its scope. If the work was already
  // finished by a later run the endpoint reports no work and nothing happens.
  const resume = async (j: any) => {
    setError('');
    try {
      const r: any = await api.enqueueClassifierJob({ classifier_id: j.classifier_id, playlist_id: j.playlist_id });
      if (r.created?.length) {
        setNotice('Re-queued ' + j.classifier_name + ' on ' + (j.playlist_name || 'its playlist') + ' - it will classify whatever is still missing.');
      } else if (r.skipped_playlists?.length) {
        setNotice(j.classifier_name + ' on ' + (j.playlist_name || 'that playlist') + ' already has a job in flight - nothing to resume.');
      } else {
        setNotice('Re-check of ' + j.classifier_name + ': nothing left to classify - coverage is already complete.');
      }
      refresh();
    } catch (e: any) { setError(e?.message || String(e)); }
  };

  const deleteJob = async (jid: number) => {
    setError('');
    try { await api.deleteClassifierJob(jid); refresh(); }
    catch (e: any) { setError(e?.message || String(e)); }
  };

  return (
    <Box>
      <PageHeader
        icon={<SmartToyIcon />}
        title="AI Classifiers"
        intro={(
          <>
            A classifier is a natural-language question about your music. Its answer is pre-computed for
            every track by a background batch job (chunked LLM calls, strict JSON schema), and then shows up
            on the Search page as a regular instant filter. You can preview a definition on a few tracks
            before saving; editing a definition marks all existing values stale and the jobs below re-run
            automatically.
          </>
        )}
        actions={(
          <>
            <Button startIcon={<RefreshIcon />} onClick={refresh} size="small">Refresh</Button>
            <Button variant="contained" startIcon={<AddIcon />} onClick={() => setModal({ mode: 'create' })} size="small">
              New classifier
            </Button>
          </>
        )}
      />

      {error ? <Alert severity="error" sx={{ mb: 2 }} onClose={() => setError('')}>{error}</Alert> : null}
      {notice ? <Alert severity="success" sx={{ mb: 2 }} onClose={() => setNotice('')}>{notice}</Alert> : null}

      <DataTable>
        <TableContainer>
          <Table size="small">
            <TableHead>
              <TableRow>
                <TableCell>Name</TableCell>
                <TableCell>Definition</TableCell>
                <TableCell>Type</TableCell>
                <TableCell align="center">Rev</TableCell>
                <TableCell align="center">Classified</TableCell>
                <TableCell align="center">Stale</TableCell>
                <TableCell align="center">Unclassified</TableCell>
                <TableCell align="right">Actions</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {classifiers.map((c) => {
                const s = c.stats || { current: 0, stale: 0, unclassified: 0, total: 0 };
                return (
                  <TableRow key={c.id} hover>
                    <TableCell sx={{ fontWeight: 600 }}>{c.name}</TableCell>
                    <TableCell sx={{ maxWidth: 340 }}>
                      <Tooltip title={c.query}><Typography noWrap variant="body2">{c.query}</Typography></Tooltip>
                    </TableCell>
                    <TableCell>{c.field_type || <Chip size="small" label="inferring…" color="warning" />}</TableCell>
                    <TableCell align="center">{c.revision}</TableCell>
                    <TableCell align="center">
                      {s.current?.toLocaleString()}{c.field_type === 'boolean' && s.true_count != null ? <Typography component="span" variant="caption" color="text.secondary"> ({s.true_count.toLocaleString()} true)</Typography> : null}
                    </TableCell>
                    <TableCell align="center">{s.stale ? <Chip size="small" color="warning" label={s.stale.toLocaleString()} /> : '0'}</TableCell>
                    <TableCell align="center">{s.unclassified?.toLocaleString()}</TableCell>
                    <TableCell align="right">
                      <Box sx={{ display: 'flex', gap: 0.5, justifyContent: 'flex-end' }}>
                        <Button size="small" startIcon={<EditIcon />} onClick={() => setModal({ mode: 'edit', classifier: c })}>
                          Edit
                        </Button>
                        <Button size="small" startIcon={<PlayArrowIcon />} onClick={() => enqueueAll(c.id)} disabled={!c.field_type}>
                          Classify all
                        </Button>
                      </Box>
                    </TableCell>
                  </TableRow>
                );
              })}
              {!loading && classifiers.length === 0 ? (
                <TableRow><TableCell colSpan={8}><Box sx={{ py: 2, textAlign: 'center' }} color="text.secondary">No classifiers yet — add one above.</Box></TableCell></TableRow>
              ) : null}
            </TableBody>
          </Table>
        </TableContainer>
      </DataTable>

      <SectionLabel sx={{ mt: 3, mb: 1 }}>Batch jobs</SectionLabel>
      <DataTable>
        <TableContainer>
          <Table size="small">
            <TableHead>
              <TableRow>
                <TableCell>#</TableCell>
                <TableCell>Classifier</TableCell>
                <TableCell>Playlist</TableCell>
                <TableCell>Status</TableCell>
                <TableCell sx={{ minWidth: 200 }}>Progress</TableCell>
                <TableCell align="center">Failed</TableCell>
                <TableCell align="center">Time</TableCell>
                <TableCell>Error</TableCell>
                <TableCell align="right">Actions</TableCell>

              </TableRow>
            </TableHead>
            <TableBody>
              {jobs.map((j) => {
                const pct = j.total > 0 ? Math.min(100, Math.round((j.done / j.total) * 100)) : (j.status === 'done' ? 100 : 0);
                const active = ['queued', 'running', 'cancelling'].includes(j.status);
                const retrying = j.state === 'retrying';
                const state = j.state || j.status;
                const pulse = statusPulse[state] || 'idle';
                // Ledger vs. reality: the job's `total` is an enqueue-time
                // snapshot, so a done job can read 4,224/4,649 while the scope
                // is actually fully classified (playlist grew mid-run, or a
                // later job finished the rest). `needing` (from the API) is the
                // scope's REAL remaining work right now - it is the single
                // condition that decides both the status and Resume.
                const needing = j.needing ?? 0;
                const partial = state === 'done' && j.done < j.total && needing > 0;
                const completeShort = state === 'done' && j.done < j.total && needing === 0;
                // A newer job for the same (classifier, playlist) scope supersedes
                // this one: resuming it would be redundant (or would un-pause a
                // scope the user deliberately paused via the newer job).
                const superseded = jobs.some((o) => o.id !== j.id && o.classifier_id === j.classifier_id
                  && o.playlist_id === j.playlist_id && o.id > j.id);
                return (
                  <TableRow key={j.id} hover className={pulse === 'running' ? 'dsh-row--running' : undefined}>
                    <TableCell>{j.id}</TableCell>
                    <TableCell>{j.classifier_name}</TableCell>
                    <TableCell>{j.playlist_name}</TableCell>
                    <TableCell>
                      <Tooltip title={
                        partial ? 'Genuinely unfinished: ' + needing.toLocaleString() + ' track(s) in this scope still have no current value. Resume classifies them.'
                          : completeShort ? 'This run\'s counter stopped at ' + j.done.toLocaleString() + ' / ' + j.total.toLocaleString() + ' (the scope changed mid-run, or a later run picked up the rest), but the scope is now fully classified - nothing to resume.'
                            : ''}>
                        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                          <PulseDot state={partial ? 'idle' : pulse} />
                          <Typography variant="body2" sx={{ fontWeight: 600, textTransform: 'capitalize', opacity: partial || pulse === 'idle' ? 0.7 : 1 }}>{partial ? 'partial' : state}</Typography>
                        </Box>
                      </Tooltip>
                    </TableCell>
                    <TableCell>
                      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                        {active || j.status === 'done' ? (
                          <LinearProgress variant="determinate" value={completeShort ? 100 : pct} sx={{ flexGrow: 1, height: 8, borderRadius: 4 }} />
                        ) : retrying ? (
                          <LinearProgress variant="indeterminate" sx={{ flexGrow: 1, height: 8 }} />
                        ) : (
                          <Box sx={{ flexGrow: 1 }} />
                        )}
                        <Typography variant="caption" color="text.secondary" sx={{ whiteSpace: 'nowrap' }}>
                          {completeShort ? 'complete' : j.done.toLocaleString() + ' / ' + j.total.toLocaleString()}
                        </Typography>
                      </Box>
                    </TableCell>
                    <TableCell align="center">{j.failed || 0}</TableCell>
                    <TableCell align="center">
                      <Typography variant="caption" color="text.secondary" sx={{ whiteSpace: 'nowrap' }}>
                        {elapsed(j, now)}{etaText(j, now)}
                      </Typography>
                    </TableCell>
                    <TableCell sx={{ maxWidth: 280 }}>
                      {(retrying || state === 'failed') && j.error ? (
                        <Box>
                          <Typography noWrap variant="caption" color={retrying ? 'warning.main' : 'error'}>{j.error}</Typography>
                          {retrying && j.retry_after ? (
                            <Typography variant="caption" color="text.secondary">
                              auto-retrying at {new Date(j.retry_after).toLocaleTimeString()} · attempt {j.attempts + 1} · progress kept
                            </Typography>
                          ) : null}
                        </Box>
                      ) : null}
                    </TableCell>
                    <TableCell align="right">
                      <Box sx={{ display: 'flex', gap: 0.5, justifyContent: 'flex-end' }}>
                        {active ? (
                          <Button size="small" color="warning" startIcon={<StopIcon />} onClick={() => cancel(j.id)}>Cancel</Button>
                        ) : null}
                        {retrying || state === 'failed' ? (
                          <Button size="small" startIcon={<RefreshIcon />} onClick={() => retry(j.id)}>Retry now</Button>
                        ) : null}
                        {partial && j.classifier_name && !superseded ? (
                          <Button size="small" startIcon={<PlayArrowIcon />} onClick={() => resume(j)}>Resume</Button>
                        ) : null}
                        {['done', 'cancelled', 'error', 'failed'].includes(state) ? (
                          <Button size="small" onClick={() => deleteJob(j.id)}>Remove</Button>
                        ) : null}
                      </Box>
                    </TableCell>
                  </TableRow>
                );
              })}
              {!loading && jobs.length === 0 ? (
                <TableRow><TableCell colSpan={9}><Box sx={{ py: 2, textAlign: 'center' }} color="text.secondary">No jobs yet — they appear automatically when a classifier needs work.</Box></TableCell></TableRow>
              ) : null}
            </TableBody>
          </Table>
        </TableContainer>
      </DataTable>

      {modal ? (
        <ClassifierModal
          mode={modal.mode}
          classifier={modal.mode === 'edit' ? modal.classifier : undefined}
          onClose={() => setModal(null)}
          onSaved={(msg) => { setNotice(msg); refresh(); }}
        />
      ) : null}
    </Box>
  );
}
