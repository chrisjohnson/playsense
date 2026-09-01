import { useState, useEffect } from 'react';
import AppBar from '@mui/material/AppBar';
import Toolbar from '@mui/material/Toolbar';
import Typography from '@mui/material/Typography';
import Container from '@mui/material/Container';
import Tabs from '@mui/material/Tabs';
import Tab from '@mui/material/Tab';
import Box from '@mui/material/Box';
import Chip from '@mui/material/Chip';

import Home from './pages/Home';
import Search from './pages/Search';
import Generate from './pages/Generate';
import Runs from './pages/Runs';
import Tracks from './pages/Tracks';
import Classifiers from './pages/Classifiers';
import { api } from './api';

export type TabName = 'home' | 'search' | 'generate' | 'runs' | 'tracks' | 'ai';

export default function App() {
  const [tab, setTab] = useState<TabName>('home');
  const [tracksId, setTracksId] = useState<number | null>(null);
  const [authed, setAuthed] = useState<boolean | null>(null);
  const [display, setDisplay] = useState('');
  const [authUrl, setAuthUrl] = useState('');
  const [configured, setConfigured] = useState<boolean>(false);
  const [oauthMsg, setOauthMsg] = useState<string>('');

  const refreshAuth = async () => {
    try {
      const s = await api.authStatus();
      setAuthed(s.authenticated);
      setDisplay(s.display_name);
      setConfigured(!!s.configured);
    } catch {
      setAuthed(false);
      setConfigured(false);
    }
    try {
      const a = await api.authorizeRaw();
      if (a && a.authorize_url) setAuthUrl(a.authorize_url);
    } catch {
      /* ignore */
    }
  };

  useEffect(() => {
    const p = new URLSearchParams(window.location.search);
    const err = p.get('spotify_error');
    if (err) setOauthMsg('Spotify connection failed: ' + err);
    else if (p.get('spotify') === 'connected') setOauthMsg('Connected to Spotify!');
    if (window.history && window.history.replaceState) {
      window.history.replaceState({}, '', window.location.pathname);
    }
    refreshAuth();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Keep any open tab in sync: refresh when it regains focus/visibility, plus a
  // light 15s poll, so a tab opened before the OAuth completes updates too.
  useEffect(() => {
    const onFocus = () => refreshAuth();
    const onVis = () => { if (document.visibilityState === 'visible') refreshAuth(); };
    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onVis);
    const iv = setInterval(refreshAuth, 15000);
    return () => {
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', onVis);
      clearInterval(iv);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const tabs: TabName[] = ['home', 'search', 'generate', 'ai', 'runs', 'tracks'];

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', minHeight: '100vh' }}>
      <AppBar position="static">
        <Toolbar>
          <Typography variant="h6" sx={{ flexGrow: 1, fontWeight: 700 }}>
            Spotify Tracker
          </Typography>
          {configured === false ? (
            <Chip label="Setup required" color="warning" />
          ) : authed === false ? (
            <Chip
              label="Not connected"
              color="error"
              onClick={() => window.open(authUrl || '#', '_blank')}
            />
          ) : (
            <Chip label={display || 'Connected'} color="success" />
          )}
        </Toolbar>
        <Tabs value={tabs.indexOf(tab)} onChange={(_, v) => setTab(tabs[v])} textColor="inherit">
          {tabs.map((t) => (
            <Tab key={t} label={t[0].toUpperCase() + t.slice(1)} value={t} onClick={() => setTab(t)} />
          ))}
        </Tabs>
      </AppBar>
      <Container maxWidth="xl" sx={{ flexGrow: 1, py: 3 }}>
        {tab === 'home' && <Home onOpenTracks={(id) => { setTracksId(id); setTab('tracks'); }} authUrl={authUrl} onAuthed={setAuthed} configured={configured} onRefresh={refreshAuth} authed={!!authed} display={display} oauthMsg={oauthMsg} />}
        {tab === 'search' && <Search authed={!!authed} />}
        {tab === 'generate' && <Generate authed={!!authed} />}
        {tab === 'ai' && <Classifiers />}
        {tab === 'runs' && <Runs />}
        {tab === 'tracks' && <Tracks initialId={tracksId} onPick={(id) => setTracksId(id)} />}
      </Container>
    </Box>
  );
}
