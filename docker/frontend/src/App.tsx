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
import { api } from './api';

export type TabName = 'home' | 'search' | 'generate' | 'runs' | 'tracks';

export default function App() {
  const [tab, setTab] = useState<TabName>('home');
  const [authed, setAuthed] = useState<boolean | null>(null);
  const [display, setDisplay] = useState('');
  const [authUrl, setAuthUrl] = useState('');
  const [configured, setConfigured] = useState<boolean>(false);

  useEffect(() => {
    const init = async () => {
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
    init();
  }, []);

  const tabs: TabName[] = ['home', 'search', 'generate', 'runs', 'tracks'];

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
        {tab === 'home' && <Home onOpenTracks={(id) => { setTab('tracks'); }} authUrl={authUrl} onAuthed={setAuthed} configured={configured} />}
        {tab === 'search' && <Search authed={!!authed} />}
        {tab === 'generate' && <Generate authed={!!authed} />}
        {tab === 'runs' && <Runs />}
        {tab === 'tracks' && <Tracks />}
      </Container>
    </Box>
  );
}
