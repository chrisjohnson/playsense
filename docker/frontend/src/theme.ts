import { createTheme } from '@mui/material/styles';

// Spotify-dark, but lifted: deeper background, warmer paper, one bright
// accent (#1ed760), soft borders instead of hard elevation, rounded shapes.
const theme = createTheme({
  palette: {
    mode: 'dark',
    primary: { main: '#1ed760', dark: '#17a04a', contrastText: '#052012' },
    secondary: { main: '#4d9fff' },
    success: { main: '#1ed760' },
    warning: { main: '#ffb020' },
    error: { main: '#f15e6c' },
    info: { main: '#4d9fff' },
    background: { default: '#0d0f12', paper: '#15181d' },
    text: {
      primary: '#f4f6f9',
      secondary: 'rgba(226, 233, 244, 0.65)',
      disabled: 'rgba(226, 233, 244, 0.38)',
    },
    divider: 'rgba(255, 255, 255, 0.08)',
    action: { hover: 'rgba(255,255,255,0.05)' },
  },
  typography: {
    fontFamily: "'Inter', -apple-system, 'SF Pro Display', 'Segoe UI', Roboto, Helvetica, Arial, sans-serif",
    h4: { fontWeight: 800, letterSpacing: '-0.02em' },
    h5: { fontWeight: 700, letterSpacing: '-0.015em' },
    h6: { fontWeight: 700 },
    subtitle1: { fontWeight: 600 },
    body1: { lineHeight: 1.5 },
    button: { textTransform: 'none', fontWeight: 600, fontSize: '0.875rem' },
  },
  shape: { borderRadius: 10 },
  components: {
    MuiCard: {
      styleOverrides: {
        root: {
          border: '1px solid rgba(255,255,255,0.07)',
          background: 'linear-gradient(180deg, #171b21 0%, #13161b 100%)',
          transition: 'border-color 160ms ease, box-shadow 160ms ease',
          '&:hover': { borderColor: 'rgba(255,255,255,0.14)' },
        },
      },
    },
    MuiPaper: {
      styleOverrides: {
        root: {
          backgroundImage: 'none',
          '&.MuiPaper-outlined': { borderColor: 'rgba(255,255,255,0.07)' },
        },
      },
    },
    MuiChip: { styleOverrides: { root: { borderRadius: 999 } } },
    MuiButton: {
      styleOverrides: {
        root: { borderRadius: 8 },
        contained: {
          boxShadow: '0 1px 2px rgba(0,0,0,0.4), 0 0 0 0 rgba(30,215,96,0)',
          '&.MuiButton-containedPrimary:hover': {
            boxShadow: '0 4px 14px rgba(30,215,96,0.25)',
          },
        },
      },
    },
    MuiDialog: {
      styleOverrides: {
        paper: {
          borderRadius: 16,
          background: '#14171c',
          border: '1px solid rgba(255,255,255,0.08)',
          backgroundImage: 'none',
        },
      },
    },
    MuiTooltip: {
      styleOverrides: {
        tooltip: {
          borderRadius: 8,
          background: '#20252d',
          border: '1px solid rgba(255,255,255,0.1)',
          fontSize: '0.78rem',
        },
      },
    },
    MuiLinearProgress: {
      styleOverrides: {
        root: { borderRadius: 999, background: 'rgba(255,255,255,0.08)' },
      },
    },
    MuiTable: {
      styleOverrides: {
        root: {
          '& .MuiTableCell-root': { borderColor: 'rgba(255,255,255,0.06)' },
        },
      },
    },
    MuiTableHead: {
      styleOverrides: {
        root: {
          '& .MuiTableCell-head': {
            color: 'rgba(226, 233, 244, 0.55)',
            fontWeight: 700,
            fontSize: '0.7rem',
            textTransform: 'uppercase',
            letterSpacing: '0.07em',
            // OPAQUE on purpose: the old 2%-white tint let scrolled rows show
            // through the sticky Search header (a 2% white blend over the
            // #15181d paper, computed to the same look)
            backgroundColor: '#1a1d22',
          },
        },
      },
    },
    MuiAlert: {
      styleOverrides: {
        root: {
          borderRadius: 10,
          '& .MuiAlert-icon': { opacity: 0.9 },
        },
      },
    },
    MuiSwitch: {
      styleOverrides: {
        root: { '&.Mui-checked .MuiSwitch-thumb': { boxShadow: '0 0 8px rgba(30,215,96,0.7)' } },
      },
    },
  },
});

export default theme;
