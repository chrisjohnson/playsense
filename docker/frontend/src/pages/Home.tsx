import { useState, useEffect } from 'react';
import Grid from '@mui/material/Grid';
import Card from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import Button from '@mui/material/Button';
import Typography from '@mui/material/Typography';
import Box from '@mui/material/Box';
import LinearProgress from '@mui/material/LinearProgress';
import { api, PlaylistItem } from '../api';

interface Props {
  onOpenTracks: (id: number) => void;
  authUrl: string;
  onAuthed: (v: boolean) => void;
  configured: boolean;
}

export default function Home({ onOpenTracks, authUrl, onAuthed, configured }: Props) {
  const [pls, setPls] = useState<PlaylistItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState<number | null>(null);

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
    if (!authUrl) {
      api.authorizeRaw().then((r: any) => ({})).catch(() => {});
    }
    load();
  }, []);

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
          <Typography color="text.secondary">Spotify OAuth requires server-side credentials.</Typography>
          <Typography color="text.secondary" sx={{ mt: 1 }}>
            Setup steps:
          </Typography>
          <Typography color="text.secondary">
            1. Create a Spotify app at developer.spotify.com.
          </Typography>
          <Typography color="text.secondary">
            2. Set SPOTIFY_CLIENT_ID and SPOTIFY_CLIENT_SECRET in the backend .env (docker-compose.yml or -e flags for the api container).
          </Typography>
          <Typography color="text.secondary">
            3. Add the Redirect URI http://localhost:8000/api/oauth/redirect (or http://localhost:3000/api/oauth/redirect).
          </Typography>
          <Typography color="text.secondary">
            4. Restart the api container.
          </Typography>
        </Box>
      ) : (
        <Box sx={{ mb: 3 }}>
          <Typography variant="h5" gutterBottom>Get started</Typography>
          <Typography color="text.secondary">
            1. Create a Spotify app and add the Redirect URI: /api/oauth/redirect
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
