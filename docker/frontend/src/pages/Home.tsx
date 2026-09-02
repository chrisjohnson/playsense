import { useState, useEffect } from 'react';
import Grid from '@mui/material/Grid';
import Card from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import Button from '@mui/material/Button';
import Typography from '@mui/material/Typography';
import Box from '@mui/material/Box';
import TextField from '@mui/material/TextField';
import LinearProgress from '@mui/material/LinearProgress';
import Chip from '@mui/material/Chip';
import Alert from '@mui/material/Alert';
import MusicNoteIcon from '@mui/icons-material/MusicNote';
import PlaylistAddCheckIcon from '@mui/icons-material/PlaylistAddCheck';
import StarIcon from '@mui/icons-material/Star';
import StarOutlineIcon from '@mui/icons-material/StarOutline';
import DownloadIcon from '@mui/icons-material/Download';
import AutoAwesomeIcon from '@mui/icons-material/AutoAwesome';
import { api, PlaylistItem } from '../api';
import { EmptyState } from '../components';

// deterministic pastel hue per playlist so cards are scannable
function playlistHue(id: number): string {
  const h = (Math.abs(id) * 47 + 120) % 360;
  return 'hsl(' + h + ' 52% 46%)';
}

interface Props {
  authUrl: string;
  onAuthed: (v: boolean) => void;
  configured: boolean;
  onRefresh: () => void;
  authed: boolean;
  display: string;
  oauthMsg: string;
}

const REDIRECT_URI = 'https://local-ai-machine.local:6111/api/oauth/redirect';
const SPOTIFY_CREATE_URL = 'https://developer.spotify.com/dashboard/create';

function dlStatus(p: PlaylistItem) {
  const st = p.download_state || 'idle';
  if (st === 'idle') return null;
  if (st === 'queued') {
    return (
      <Box sx={{ mt: 1 }}>
        <Typography variant="caption" color="text.secondary">Queued — the background worker will start shortly.</Typography>
      </Box>
    );
  }
  if (st === 'downloading') {
    const pct = p.download_total ? Math.min(100, Math.round(((p.download_saved || 0) / p.download_total) * 100)) : undefined;
    return (
      <Box sx={{ mt: 1 }}>
        <LinearProgress variant={pct != null ? 'determinate' : 'indeterminate'} value={pct ?? 0} sx={{ mb: 0.5 }} />
        <Typography variant="caption" color="text.secondary">
          Downloading… {p.download_saved || 0}{p.download_total ? ` / ${p.download_total}` : ''} tracks (grinds across Spotify quota windows)
        </Typography>
      </Box>
    );
  }
  if (st === 'waiting_quota') {
    return (
      <Box sx={{ mt: 1 }}>
        <LinearProgress variant="indeterminate" sx={{ mb: 0.5 }} />
        <Typography variant="caption" color="warning.main">
          {p.download_error || 'Spotify quota exhausted'} — saved {p.download_saved || 0}{p.download_total ? ` / ${p.download_total}` : ''}, resuming automatically
        </Typography>
      </Box>
    );
  }
  if (st === 'done') {
    return (
      <Box sx={{ mt: 1 }}>
        <Typography variant="caption" color="success.main">Download complete — {p.download_saved || 0} tracks saved.</Typography>
      </Box>
    );
  }
  return (
    <Box sx={{ mt: 1 }}>
      <Typography variant="caption" color="error">Download stopped: {p.download_error || 'error'}</Typography>
    </Box>
  );
}

export default function Home({ onAuthed, configured, onRefresh, authed, display, oauthMsg }: Props) {
  const [pls, setPls] = useState<PlaylistItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState<number | null>(null);
  const [busyDefault, setBusyDefault] = useState<number | null>(null);
  const [cid, setCid] = useState('');
  const [csecret, setCsecret] = useState('');
  const [saving, setSaving] = useState(false);
  const [saveMsg, setSaveMsg] = useState('');
  const [syncing, setSyncing] = useState(false);

  const load = async () => {
    setLoading(true);
    try {
      const data = await api.playlists();
      setPls(Array.isArray(data) ? data : []);
    } catch (e) {
      console.error(e);
    } finally {
      setLoading(false);
    }
  };

  const doSync = async () => {
    setSyncing(true);
    try {
      await api.sync();
      await load();
    } catch (e: any) {
      alert('Sync failed: ' + (e.message || e));
    } finally {
      setSyncing(false);
    }
  };

  useEffect(() => {
    load();
  }, []);

  const doSaveCreds = async () => {
    setSaving(true);
    setSaveMsg('');
    try {
      await api.saveCredentials(cid.trim(), csecret.trim());
      setSaveMsg('Saved — you can now connect to Spotify.');
      await onRefresh();
    } catch (e: any) {
      setSaveMsg('Save failed: ' + (e.message || e));
    } finally {
      setSaving(false);
    }
  };

  const copyRedirect = async () => {
    try {
      await navigator.clipboard.writeText(REDIRECT_URI);
      setSaveMsg('Redirect URI copied to clipboard.');
    } catch {
      setSaveMsg('Copy failed — select the text manually.');
    }
  };

  const doDownload = async (id: number) => {
    setBusy(id);
    try {
      await api.download(id);
      await load();
    } catch (e: any) {
      alert('Could not queue download: ' + (e.message || e));
    } finally {
      setBusy(null);
    }
  };

  // While any download is active, poll for progress (the worker grinds in the
  // background across Spotify quota windows).
  const anyActive = pls.some((p) => ['queued', 'downloading', 'waiting_quota'].includes(p.download_state || ''));
  useEffect(() => {
    if (!anyActive) return;
    const t = setInterval(load, 5000);
    return () => clearInterval(t);
  }, [anyActive]);

  const doSetDefault = async (id: number) => {
    setBusyDefault(id);
    try {
      await api.setDefaultPlaylist(id);
      await load();
    } catch (e: any) {
      alert('Could not set default: ' + (e.message || e));
    } finally {
      setBusyDefault(null);
    }
  };

  const reconnect = () => {
    api.authorizeRaw().then((r: any) => {
      if (r && r.authorize_url) window.open(r.authorize_url, '_blank');
    });
  };

  const doClassify = async (id: number) => {
    setBusy(id);
    try {
      const r = await api.classify(id, 'Manual classification', true);
      await load();
      alert(`Classified. Mexican: ${r.n_mexican}, Latin American: ${r.n_latin_american}`);
    } catch (e: any) {
      alert('Classification failed: ' + (e.message || e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <Box>
      {!configured ? (
        <Box sx={{ mb: 3 }}>
          <Typography variant="h5" gutterBottom>Spotify is not set up yet</Typography>
          <Typography color="text.secondary">Spotify OAuth needs your app's Client ID and Secret.</Typography>
          <Typography color="text.secondary" sx={{ mt: 1 }}>Setup steps:</Typography>
          <Typography color="text.secondary">
            1. Create a Spotify app: <a href={SPOTIFY_CREATE_URL} target="_blank" rel="noreferrer">developer.spotify.com/dashboard/create</a>
          </Typography>
          <Typography color="text.secondary" sx={{ mt: 1 }}>2. On your app's page, under &ldquo;Redirect URIs&rdquo;, add exactly:</Typography>
          <Box sx={{ mt: 0.5, display: 'flex', alignItems: 'center', gap: 1, flexWrap: 'wrap' }}>
            <Box component="code" sx={{ bgcolor: 'action.hover', px: 1, py: 0.5, borderRadius: 1, userSelect: 'all' }}>
              {REDIRECT_URI}
            </Box>
            <Button size="small" variant="outlined" onClick={copyRedirect}>Copy</Button>
          </Box>
          <Typography color="text.secondary" sx={{ mt: 1 }}>
            3. Copy your Client ID and Client Secret, paste them below, and Save &mdash; the server stores them for you (no .env editing needed).
          </Typography>
          <Box sx={{ mt: 2, display: 'flex', flexDirection: 'column', gap: 1.5, maxWidth: 480 }}>
            <TextField label="Client ID" value={cid} onChange={(e) => setCid(e.target.value)} size="small" variant="outlined" fullWidth />
            <TextField label="Client Secret" type="password" value={csecret} onChange={(e) => setCsecret(e.target.value)} size="small" variant="outlined" fullWidth />
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
              <Button variant="contained" color="primary" disabled={saving || !cid.trim() || !csecret.trim()} onClick={doSaveCreds}>
                {saving ? 'Saving…' : 'Save credentials'}
              </Button>
              {saveMsg && <Typography variant="body2" color="text.secondary">{saveMsg}</Typography>}
            </Box>
          </Box>
        </Box>
      ) : authed ? (
        <Card sx={{ mb: 3, display: 'flex', alignItems: 'center', gap: 2 }}>
          <CardContent sx={{ display: 'flex', alignItems: 'center', gap: 2, flexGrow: 1 }}>
            <Box sx={{
              width: 44, height: 44, borderRadius: '50%', flexShrink: 0,
              background: 'linear-gradient(135deg, #1ed760, #0f9d46)',
              color: '#052012', display: 'flex', alignItems: 'center', justifyContent: 'center',
              fontWeight: 800, fontSize: '1.05rem',
            }}>
              {(display || 'S').charAt(0).toUpperCase()}
            </Box>
            <Box sx={{ flexGrow: 1, minWidth: 0 }}>
              <Typography variant="h6">Connected as {display || 'Spotify'}</Typography>
              <Typography variant="body2" color="text.secondary" noWrap>
                Sync your playlists below, download the ones you want to analyze, then build searches.
              </Typography>
              <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 0.5, opacity: 0.8 }}>
                Tip: if a generated-playlist sync fails with "403 Forbidden", click Reconnect once to re-grant the playlist-write scopes.
              </Typography>
            </Box>
            <Button size="small" variant="outlined" onClick={reconnect}>Reconnect</Button>
          </CardContent>
        </Card>
      ) : (
        <Box sx={{ mb: 3 }}>
          <Typography variant="h5" gutterBottom>Get started</Typography>
          <Typography color="text.secondary">
            Redirect URI (must match your Spotify app): {REDIRECT_URI}
          </Typography>
          <Button variant="contained" color="primary"
            onClick={() => api.authorizeRaw().then((r: any) => {
              onAuthed(true);
              if (r && r.authorize_url) window.open(r.authorize_url, '_blank');
            })} sx={{ mt: 1 }}>
            Connect to Spotify
          </Button>
        </Box>
      )}
      {oauthMsg ? (
        <Alert severity={oauthMsg.startsWith('Connected') ? 'success' : 'error'} sx={{ mb: 2 }}>
          {oauthMsg}
        </Alert>
      ) : null}
      {loading ? <LinearProgress /> : null}
      <Box sx={{ display: 'flex', alignItems: 'center', mb: 2 }}>
        <Typography variant="h5" gutterBottom sx={{ flexGrow: 1 }}>Your playlists</Typography>
        <Button onClick={doSync} variant="outlined" disabled={syncing || !authed}>
          {syncing ? 'Syncing…' : 'Sync from Spotify'}
        </Button>
      </Box>
      {authed && pls.length === 0 && !loading && (
        <EmptyState
          icon={<PlaylistAddCheckIcon sx={{ fontSize: 44 }} />}
          title="No playlists loaded yet"
          hint={<>Click <b>Sync from Spotify</b> to pull your playlists, then download the ones you want to analyze.</>}
        />
      )}
      <Grid container spacing={2}>
        {pls.map((p) => (
          <Grid item xs={12} sm={6} md={4} key={p.spotify_playlist_id}>
            <Card sx={{
              height: '100%', display: 'flex', flexDirection: 'column',
              transition: 'transform 160ms ease, border-color 160ms ease, box-shadow 160ms ease',
              '&:hover': { transform: 'translateY(-3px)', boxShadow: '0 10px 28px rgba(0,0,0,0.4)', borderColor: 'rgba(255,255,255,0.18)' },
            }}>
              <CardContent sx={{ display: 'flex', flexDirection: 'column', flexGrow: 1 }}>
                <Box sx={{ display: 'flex', alignItems: 'flex-start', gap: 1.25 }}>
                  <Box sx={{
                    width: 44, height: 44, borderRadius: 2, flexShrink: 0,
                    background: 'linear-gradient(135deg, ' + playlistHue(p.id) + ' 0%, rgba(0,0,0,0.55) 130%)',
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    boxShadow: 'inset 0 0 0 1px rgba(255,255,255,0.12)',
                  }}>
                    <MusicNoteIcon sx={{ color: 'rgba(255,255,255,0.9)', fontSize: 22 }} />
                  </Box>
                  <Box sx={{ flexGrow: 1, minWidth: 0 }}>
                    <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.75 }}>
                      <Typography variant="h6" noWrap sx={{ flexGrow: 1 }}>{p.name}</Typography>
                      {p.is_default ? <Chip size="small" color="primary" icon={<StarIcon sx={{ fontSize: '1rem !important' }} />} label="default" sx={{ height: 20, fontSize: '0.68rem' }} /> : null}
                    </Box>
                    <Typography variant="body2" color="text.secondary" noWrap>{p.description || p.owner_id}</Typography>
                  </Box>
                </Box>
                <Box sx={{ mt: 1.5 }}>
                  <Typography variant="body2" sx={{ opacity: 0.9 }}>{(p.track_count || 0).toLocaleString()} tracks</Typography>
                </Box>
                {dlStatus(p)}
                <Box sx={{ mt: 'auto', pt: 1.5, display: 'flex', gap: 0.75, flexWrap: 'wrap' }}>
                  <Button size="small" variant="outlined" startIcon={<DownloadIcon />}
                    onClick={() => doDownload(p.id)}
                    disabled={busy === p.id || ['queued', 'downloading', 'waiting_quota'].includes(p.download_state || '')}>
                    {busy === p.id ? 'Queuing…' : (p.download_state === 'done' ? 'Re-download' : 'Download')}
                  </Button>
                  <Button size="small" startIcon={<AutoAwesomeIcon />} onClick={() => doClassify(p.id)} disabled={busy === p.id}>
                    {busy === p.id ? 'Classifying…' : 'Classify'}
                  </Button>
                  {p.is_default ? null : (
                    <Button size="small" startIcon={<StarOutlineIcon />} onClick={() => doSetDefault(p.id)} disabled={busyDefault === p.id}>
                      {busyDefault === p.id ? 'Setting…' : 'Set default'}
                    </Button>
                  )}
                </Box>
              </CardContent>
            </Card>
          </Grid>
        ))}
      </Grid>
    </Box>
  );
}
