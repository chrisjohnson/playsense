import { useState, useEffect } from 'react';
import AppBar from '@mui/material/AppBar';
import Toolbar from '@mui/material/Toolbar';
import Typography from '@mui/material/Typography';
import Container from '@mui/material/Container';
import Tabs from '@mui/material/Tabs';
import Tab from '@mui/material/Tab';
import Box from '@mui/material/Box';
import Chip from '@mui/material/Chip';
import Tooltip from '@mui/material/Tooltip';
import MusicNoteIcon from '@mui/icons-material/MusicNote';
import HouseIcon from '@mui/icons-material/House';
import SearchIcon from '@mui/icons-material/Search';
import AutoAwesomeIcon from '@mui/icons-material/AutoAwesome';
import SmartToyIcon from '@mui/icons-material/SmartToy';

import Home from './pages/Home';
import Search from './pages/Search';
import Generate from './pages/Generate';
import Classifiers from './pages/Classifiers';
import { api } from './api';

export type TabName = 'home' | 'search' | 'generate' | 'ai';

// Tabs are reflected in the URL hash (#/search, #/generate, ...) so refresh and
// back/forward keep you where you were.
const VALID_TABS: TabName[] = ['home', 'search', 'generate', 'ai'];

const TAB_META: Record<TabName, { label: string; icon: JSX.Element }> = {
  home: { label: 'Home', icon: <HouseIcon /> },
  search: { label: 'Search', icon: <SearchIcon /> },
  generate: { label: 'Generate', icon: <AutoAwesomeIcon /> },
  ai: { label: 'AI', icon: <SmartToyIcon /> },
};

function parseHash(): TabName {
  // the hash may carry a query (#/search?pl=4&q=...) - the tab is the path part
  const h = window.location.hash.replace(/^#\/?/, '').split('?')[0];
  if (h === '' || h === 'home') return 'home';
  const t = h.split('/')[0];
  return (VALID_TABS as string[]).includes(t) ? (t as TabName) : 'home';
}

function hashFor(tab: TabName): string {
  if (tab === 'home') return '#/';
  return '#/' + tab;
}

function ConnectionChip({ configured, authed, display, authUrl }: {
  configured: boolean; authed: boolean; display: string; authUrl: string;
}) {
  if (configured === false) return <Chip label="Setup required" color="warning" size="small" />;
  if (authed) {
    return (
      <Chip size="small" color="success" variant="outlined"
        icon={<MusicNoteIcon />}
        label={display || 'Connected'}
        sx={{ '& .MuiChip-icon': { color: 'primary.main' } }}
      />
    );
  }
  return (
    <Tooltip title="Click to connect">
      <Chip size="small" color="error" variant="outlined" label="Not connected"
        onClick={() => window.open(authUrl || '#', '_blank')} sx={{ cursor: 'pointer' }} />
    </Tooltip>
  );
}

export default function App() {
  const [tab, setTabState] = useState<TabName>(() => parseHash());
  const [authed, setAuthed] = useState<boolean | null>(null);
  const [display, setDisplay] = useState('');
  const [authUrl, setAuthUrl] = useState('');
  const [configured, setConfigured] = useState<boolean>(false);
  const [oauthMsg, setOauthMsg] = useState('');

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
      // strip the OAuth query params but KEEP the hash (tab routing lives there)
      window.history.replaceState({}, '', window.location.pathname + window.location.hash);
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

  const setTab = (t: TabName) => setTabState(t);

  // Hash <-> state sync. One writer for the PATH: whenever the tab changes,
  // make the URL hash match. The SEARCH page additionally owns the query part
  // of the hash (its filter state); we keep it while on Search and drop it
  // elsewhere so other tabs get clean URLs (the Search page remembers it).
  useEffect(() => {
    const h = window.location.hash;
    const qIdx = h.indexOf('?');
    const query = tab === 'search' && qIdx >= 0 ? h.slice(qIdx) : '';
    const want = hashFor(tab) + query;
    if (window.location.hash !== want) window.location.hash = want;
  }, [tab]);

  // Browser back/forward or a manual hash edit (e.g. pasted link) -> state.
  useEffect(() => {
    const onHash = () => setTabState(parseHash());
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  const tabs: TabName[] = ['home', 'ai', 'search', 'generate'];

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', minHeight: '100vh' }}>
      <AppBar position="sticky" elevation={0} sx={{ background: 'rgba(13,15,18,0.88)', backdropFilter: 'blur(12px)', borderBottom: '1px solid rgba(255,255,255,0.06)' }}>
        <Toolbar sx={{ gap: 2 }}>
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.25, flexGrow: 1 }}>
            <Box sx={{
              width: 34, height: 34, borderRadius: 10, display: 'flex', alignItems: 'center', justifyContent: 'center',
              background: 'linear-gradient(135deg, #1ed760 0%, #0f9d46 100%)',
              boxShadow: '0 2px 10px rgba(30,215,96,0.35)', color: '#052012',
            }}>
              <MusicNoteIcon sx={{ fontSize: 20 }} />
            </Box>
            <Box>
              <Typography variant="h6" sx={{ lineHeight: 1.1, letterSpacing: -0.3, fontWeight: 800 }}>
                play<Box component="span" sx={{ color: 'primary.main' }}>sense</Box>
              </Typography>
              <Typography variant="caption" color="text.secondary" sx={{ lineHeight: 1 }}>analyze · classify · sync</Typography>
            </Box>
          </Box>
          <ConnectionChip configured={configured} authed={!!authed} display={display} authUrl={authUrl} />
        </Toolbar>
        <Tabs
          value={tabs.indexOf(tab)}
          onChange={(_, v: number) => { const t = tabs[v]; if (t && t !== tab) setTab(t); }}
          sx={{ minHeight: 44, '& .MuiTab-root': { minHeight: 44, py: 0, opacity: 0.62, '&.Mui-selected': { opacity: 1 } } }}
        >
          {tabs.map((t) => (
            <Tab key={t} icon={TAB_META[t].icon} label={TAB_META[t].label} iconPosition="start" />
          ))}
        </Tabs>
      </AppBar>
      <Container maxWidth="xl" sx={{ flexGrow: 1, py: 3.5 }}>
        <div key={tab} className="dsh-page-enter">
          {tab === 'home' && <Home authUrl={authUrl} onAuthed={setAuthed} configured={configured} onRefresh={refreshAuth} authed={!!authed} display={display} oauthMsg={oauthMsg} />}
          {tab === 'search' && <Search authed={!!authed} />}
          {tab === 'generate' && <Generate authed={!!authed} />}
          {tab === 'ai' && <Classifiers />}
        </div>
      </Container>
    </Box>
  );
}