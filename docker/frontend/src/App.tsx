import { useState, useEffect, useRef } from 'react';
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
import { lastSearchQuery } from './searchParams';

export type TabName = 'home' | 'search' | 'generate' | 'ai';

// Tabs are real paths (/search, /generate, ...) with the Search page's filters
// in the query string (/search?pl=4&q=leon). Real links (not hashes): refresh
// and back/forward keep you where you were, and cmd/ctrl+click opens a tab in
// a new window without touching the current one (a fragment link would
// rewrite the current tab too).
const VALID_TABS: TabName[] = ['home', 'search', 'generate', 'ai'];

const TAB_META: Record<TabName, { label: string; icon: JSX.Element }> = {
  home: { label: 'Home', icon: <HouseIcon /> },
  search: { label: 'Search', icon: <SearchIcon /> },
  generate: { label: 'Generate', icon: <AutoAwesomeIcon /> },
  ai: { label: 'AI', icon: <SmartToyIcon /> },
};

function parsePath(): TabName {
  const p = window.location.pathname.replace(/\/+$/, '') || '/';
  const t = p.split('/')[1] || 'home';
  return (VALID_TABS as string[]).includes(t) ? (t as TabName) : 'home';
}

function pathFor(tab: TabName): string {
  if (tab === 'home') return '/';
  return '/' + tab;
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
  const [tab, setTabState] = useState<TabName>(() => parsePath());
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
    const ok = p.get('spotify') === 'connected';
    if (err) setOauthMsg('Spotify connection failed: ' + err);
    else if (ok) setOauthMsg('Connected to Spotify!');
    if (err || ok) {
      // strip just the OAuth params, keep any others (e.g. /search?pl=4&q=...)
      p.delete('spotify_error');
      p.delete('spotify');
      const rest = p.toString();
      window.history.replaceState({}, '', window.location.pathname + (rest ? '?' + rest : ''));
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

  // URL <-> state sync. The tab owns the PATH; the Search page owns the query
  // string (its filters, remembered via ../searchParams while off-page).
  // Tab switches push a history entry; back/forward (popstate) must not.
  const firstRun = useRef(true);
  const fromPop = useRef(false);
  useEffect(() => {
    if (firstRun.current) { firstRun.current = false; return; }
    if (fromPop.current) { fromPop.current = false; return; }
    const q = lastSearchQuery();
    const want = pathFor(tab) + (tab === 'search' && q ? '?' + q : '');
    if (window.location.pathname + window.location.search !== want) {
      window.history.pushState(null, '', want);
    }
  }, [tab]);

  // Browser back/forward (or the URL bar) -> state, without pushing a new entry.
  useEffect(() => {
    const onPop = () => { fromPop.current = true; setTabState(parsePath()); };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  const tabs: TabName[] = ['home', 'ai', 'search', 'generate'];

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', minHeight: '100vh' }}>
      <AppBar position="sticky" elevation={0} sx={{ background: 'rgba(13,15,18,0.88)', backdropFilter: 'blur(12px)', borderBottom: '1px solid rgba(255,255,255,0.06)' }}>
        <Toolbar sx={{ gap: 2 }}>
          <Box component="a" href="/" aria-label="playsense home"
            sx={{ display: 'flex', alignItems: 'center', gap: 1.25, flexGrow: 1, textDecoration: 'none', color: 'inherit' }}>
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
          onChange={(e: React.SyntheticEvent, v: number) => {
            // modifier-key / middle clicks belong to the browser (new tab,
            // background tab) - never run the in-page transition for them
            const ne = e.nativeEvent as MouseEvent & KeyboardEvent;
            if (ne.metaKey || ne.ctrlKey || ne.shiftKey || ne.altKey
              || (ne instanceof MouseEvent && ne.button !== 0)) return;
            const t = tabs[v]; if (t && t !== tab) setTab(t);
          }}
          sx={{ minHeight: 44, '& .MuiTab-root': { minHeight: 44, py: 0, opacity: 0.62, '&.Mui-selected': { opacity: 1 } } }}
        >
          {tabs.map((t) => (
            // real links at real paths: a plain click is intercepted for an
            // instant SPA switch; cmd/ctrl/shift+click, middle-click and
            // right-click are left fully to the browser (new tab, background
            // tab, copy address, ...) and never touch the current page.
            <Tab key={t} component="a" href={pathFor(t)} icon={TAB_META[t].icon}
              label={TAB_META[t].label} iconPosition="start" aria-label={TAB_META[t].label}
              onClick={(e: React.MouseEvent) => {
                if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
                e.preventDefault();
                setTab(t);
              }} />
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