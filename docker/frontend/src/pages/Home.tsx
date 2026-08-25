import { useState, useEffect } from 'react';
import Grid from '@mui/material/Grid';
import Card from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import Button from '@mui/material/Button';
import Typography from '@mui/material/Typography';
import Box from '@mui/material/Box';
import TextField from '@mui/material/TextField';
import LinearProgress from '@mui/material/LinearProgress';
import { api, PlaylistItem } from '../api';

interface Props {
  onOpenTracks: (id: number) => void;
  authUrl: string;
  onAuthed: (v: boolean) => void;
  configured: boolean;
  onRefresh: () => void;
}

const REDIRECT_URI = 'https://local-ai-machine.local:6111/api/oauth/redirect';
const SPOTIFY_CREATE_URL = 'https://developer.spotify.com/dashboard/create';

export default function Home({ onOpenTracks, authUrl, onAuthed, configured, onRefresh }: Props) {
  const [pls, setPls] = useState<PlaylistItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState<number | null>(null);
  const [cid, setCid] = useState('');
  const [csecret, setCsecret] = useState('');
  const [saving, setSaving] = useState(false);
  const [saveMsg, setSaveMsg] = useState('');

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
      const r = await api.download(id);
      await load();
      alert(`Downloaded ${r.downloaded} tracks.`);
    } catch (e: any) {
      alert('Download failed: ' + (e.message || e));
    } finally {
      setBusy(null);
    }
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
      {loading ? <LinearProgress /> : null}
      <Box sx={{ display: 'flex', alignItems: 'center', mb: 2 }}>
        <Typography variant="h5" gutterBottom sx={{ flexGrow: 1 }}>Your playlists</Typography>
        <Button onClick={load} variant="outlined">Refresh</Button>
      </Box>
      <Grid container spacing={2}>
        {pls.map((p) => (
          <Grid item xs={12} sm={6} md={4} key={p.spotify_playlist_id}>
            <Card variant="outlined">
              <CardContent>
                <Typography variant="h6" noWrap>{p.name}</Typography>
                <Typography variant="body2" color="text.secondary" noWrap>{p.description || p.owner_id}</Typography>
                <Typography variant="body2">{p.track_count} tracks</Typography>
                <Box sx={{ mt: 1, display: 'flex', gap: 1 }}>
                  <Button size="small" onClick={() => doDownload(p.id)} disabled={busy === p.id}>
                    {busy === p.id ? 'Downloading...' : 'Download'}
                  </Button>
                  <Button size="small" onClick={() => doClassify(p.id)} disabled={busy === p.id}>
                    {busy === p.id ? 'Classifying...' : 'Classify'}
                  </Button>
                  <Button size="small" onClick={() => onOpenTracks(p.id)}>View tracks</Button>
                </Box>
              </CardContent>
            </Card>
          </Grid>
        ))}
      </Grid>
    </Box>
  );
}
