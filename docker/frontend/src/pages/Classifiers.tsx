import { useState, useEffect, useCallback } from 'react';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import TextField from '@mui/material/TextField';
import MenuItem from '@mui/material/MenuItem';
import Button from '@mui/material/Button';
import Paper from '@mui/material/Paper';
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
import AddIcon from '@mui/icons-material/Add';
import PlayArrowIcon from '@mui/icons-material/PlayArrow';
import StopIcon from '@mui/icons-material/Stop';
import SmartToyIcon from '@mui/icons-material/SmartToy';
import RefreshIcon from '@mui/icons-material/Refresh';

import { api, Classifier, ClassifierJob } from '../api';

const statusColor: Record<string, 'default' | 'primary' | 'success' | 'warning' | 'error'> = {
  queued: 'default', running: 'primary', cancelling: 'warning',
  done: 'success', error: 'error', cancelled: 'default',
};

function elapsed(j: ClassifierJob): string {
  const start = j.started_at ? new Date(j.started_at).getTime() : (j.created_at ? new Date(j.created_at).getTime() : 0);
  const end = j.finished_at ? new Date(j.finished_at).getTime() : Date.now();
  const s = Math.max(0, Math.round((end - start) / 1000));
  if (s < 60) return s + 's';
  return Math.floor(s / 60) + 'm ' + (s % 60) + 's';
}

export default function Classifiers() {
  const [classifiers, setClassifiers] = useState<Classifier[]>([]);
  const [jobs, setJobs] = useState<ClassifierJob[]>([]);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [loading, setLoading] = useState(true);

  const [name, setName] = useState('');
  const [query, setQuery] = useState('');
  const [fieldType, setFieldType] = useState('');
  const [creating, setCreating] = useState(false);

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

  const create = async () => {
    if (!name.trim() || !query.trim()) { setNotice('Name and definition are required.'); return; }
    setCreating(true); setError('');
    try {
      await api.createClassifier({ name: name.trim(), query: query.trim(), ...(fieldType ? { field_type: fieldType } : {}) });
      setNotice('Classifier "' + name.trim() + '" created — the job manager will pick it up automatically.');
      setName(''); setQuery(''); setFieldType('');
      refresh();
    } catch (e: any) { setError(e?.message || String(e)); }
    finally { setCreating(false); }
  };

  const enqueueAll = async (cid: number) => {
    setError('');
    try {
      const r: any = await api.enqueueClassifierJob({ classifier_id: cid });
      setNotice('Enqueued ' + (r.created?.length ?? 0) + ' job(s)');
      refresh();
    } catch (e: any) { setError(e?.message || String(e)); }
  };

  const cancel = async (jid: number) => {
    setError('');
    try { await api.cancelClassifierJob(jid); refresh(); }
    catch (e: any) { setError(e?.message || String(e)); }
  };

  const deleteJob = async (jid: number) => {
    setError('');
    try { await api.deleteClassifierJob(jid); refresh(); }
    catch (e: any) { setError(e?.message || String(e)); }
  };

  return (
    <Box>
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5, mb: 1 }}>
        <SmartToyIcon color="primary" />
        <Typography variant="h5" sx={{ flexGrow: 1 }}>AI Classifiers</Typography>
        <Button startIcon={<RefreshIcon />} onClick={refresh} size="small">Refresh</Button>
      </Box>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 2, maxWidth: 900 }}>
        A classifier is a natural-language question about your music. Its answer is pre-computed for every
        track by a background batch job (chunked LLM calls, strict JSON schema), and then shows up on the
        Search page as a regular instant filter. Editing a definition marks all existing values stale and
        the jobs below re-run automatically. New tracks are picked up automatically too.
      </Typography>

      {error ? <Alert severity="error" sx={{ mb: 2 }} onClose={() => setError('')}>{error}</Alert> : null}
      {notice ? <Alert severity="success" sx={{ mb: 2 }} onClose={() => setNotice('')}>{notice}</Alert> : null}

      <Paper variant="outlined" sx={{ p: 2, mb: 2 }}>
        <Typography variant="subtitle1" sx={{ mb: 1 }}>Add new classifier</Typography>
        <Box sx={{ display: 'flex', gap: 1, alignItems: 'flex-end', flexWrap: 'wrap' }}>
          <TextField size="small" label="Name" value={name} onChange={(e) => setName(e.target.value)} sx={{ width: 180 }}
            placeholder="e.g. Mexican" inputProps={{ 'aria-label': 'classifier name' }} />
          <TextField size="small" label="Definition (what the LLM is asked)" value={query} onChange={(e) => setQuery(e.target.value)} sx={{ flexGrow: 1, minWidth: 320 }}
            placeholder="e.g. music that is mexican, mexican-inspired, or by a mexican artist" inputProps={{ 'aria-label': 'classifier definition' }} />
          <TextField size="small" select label="Field type" value={fieldType} onChange={(e) => setFieldType(e.target.value)} sx={{ width: 190 }}>
            <MenuItem value="">Auto (LLM infers)</MenuItem>
            <MenuItem value="boolean">boolean</MenuItem>
            <MenuItem value="string">string</MenuItem>
            <MenuItem value="number">number</MenuItem>
            <MenuItem value="datetime">datetime</MenuItem>
          </TextField>
          <Button variant="contained" startIcon={<AddIcon />} onClick={create} disabled={creating}>
            {creating ? <CircularProgress size={16} color="inherit" /> : 'Create'}
          </Button>
        </Box>
        <Typography variant="caption" color="text.secondary">
          If the type is left to Auto, a small first-pass LLM call decides it before any batch run. Values can
          be string, boolean, number, or datetime — the type may change across revisions without a migration.
        </Typography>
      </Paper>

      <Paper variant="outlined">
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
                      <Button size="small" startIcon={<PlayArrowIcon />} onClick={() => enqueueAll(c.id)} disabled={!c.field_type}>
                        Classify all
                      </Button>
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
      </Paper>

      <Typography variant="subtitle1" sx={{ mt: 3, mb: 1 }}>Batch jobs</Typography>
      <Paper variant="outlined">
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
                return (
                  <TableRow key={j.id} hover>
                    <TableCell>{j.id}</TableCell>
                    <TableCell>{j.classifier_name}</TableCell>
                    <TableCell>{j.playlist_name}</TableCell>
                    <TableCell><Chip size="small" color={statusColor[j.status]} label={j.status} /></TableCell>
                    <TableCell>
                      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                        {active || j.status === 'done' ? (
                          <LinearProgress variant="determinate" value={pct} sx={{ flexGrow: 1, height: 8, borderRadius: 4 }} />
                        ) : j.status === 'error' ? (
                          <LinearProgress variant="indeterminate" sx={{ flexGrow: 1, height: 8 }} />
                        ) : (
                          <Box sx={{ flexGrow: 1 }} />
                        )}
                        <Typography variant="caption" color="text.secondary" sx={{ whiteSpace: 'nowrap' }}>
                          {j.done.toLocaleString()} / {j.total.toLocaleString()}
                        </Typography>
                      </Box>
                    </TableCell>
                    <TableCell align="center">{j.failed || 0}</TableCell>
                    <TableCell align="center">{elapsed(j)}</TableCell>
                    <TableCell sx={{ maxWidth: 220 }}>
                      {j.error ? <Tooltip title={j.error}><Typography noWrap variant="caption" color="error">{j.error}</Typography></Tooltip> : null}
                      {j.status === 'error' && !j.error ? <Typography variant="caption" color="error">failed — retrying after backoff</Typography> : null}
                    </TableCell>
                    <TableCell align="right">
                      {active ? (
                        <Button size="small" color="warning" startIcon={<StopIcon />} onClick={() => cancel(j.id)}>Cancel</Button>
                      ) : null}
                      {['done', 'cancelled', 'error'].includes(j.status) ? (
                        <Button size="small" onClick={() => deleteJob(j.id)}>Remove</Button>
                      ) : null}
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
      </Paper>
    </Box>
  );
}
