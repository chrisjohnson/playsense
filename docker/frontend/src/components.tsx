import React from 'react';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import { SxProps, Theme } from '@mui/material/styles';

// ---------------------------------------------------------------------------
// PulseDot — the activity indicator. Solid dot for terminal states, a glowing
// pulsing ring for anything actively doing work (running / retrying).
// ---------------------------------------------------------------------------

type PulseState = 'running' | 'queued' | 'retrying' | 'error' | 'done' | 'idle';

const PULSE_COLOR: Record<PulseState, string> = {
  running: '#1ed760',
  queued: '#9aa4b2',
  retrying: '#ffb020',
  error: '#f15e6c',
  done: '#1ed760',
  idle: '#9aa4b2',
};

export function PulseDot({ state, size = 9 }: { state: PulseState; size?: number }) {
  const active = state === 'running' || state === 'retrying';
  const ring = state === 'retrying' ? 'rgba(255,176,32,0.55)' : 'rgba(30,215,96,0.55)';
  return (
    <span
      className={'dsh-pulse-dot' + (active ? ' dsh-pulse-dot--active' : '')}
      style={{
        color: PULSE_COLOR[state],
        width: size,
        height: size,
        minWidth: size,
        opacity: state === 'idle' ? 0.5 : 1,
        animation: active ? 'dsh-pulse-glow 1.6s ease-out infinite' : undefined,
        ['--pulse-color' as any]: active ? ring : 'transparent',
      }}
    />
  );
}

// ---------------------------------------------------------------------------
// PageHeader — consistent title row: icon + title + intro, actions on the right.
// ---------------------------------------------------------------------------

export function PageHeader({ icon, title, intro, actions }: {
  icon?: React.ReactNode;
  title: string;
  intro?: React.ReactNode;
  actions?: React.ReactNode;
}) {
  return (
    <Box>
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.25, mb: intro ? 1 : 0 }}>
        {icon ? <Box sx={{ color: 'primary.main', display: 'flex' }}>{icon}</Box> : null}
        <Typography variant="h5" sx={{ flexGrow: 1 }}>{title}</Typography>
        {actions ? <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>{actions}</Box> : null}
      </Box>
      {intro ? (
        <Typography variant="body2" color="text.secondary" sx={{ mb: 2, maxWidth: 860, lineHeight: 1.6 }}>
          {intro}
        </Typography>
      ) : null}
    </Box>
  );
}

// ---------------------------------------------------------------------------
// EmptyState — friendly centered placeholder for empty lists.
// ---------------------------------------------------------------------------

export function EmptyState({ icon, title, hint, action }: {
  icon: React.ReactNode;
  title: string;
  hint?: React.ReactNode;
  action?: React.ReactNode;
}) {
  return (
    <Box sx={{
      display: 'flex', flexDirection: 'column', alignItems: 'center',
      py: 7, px: 3, textAlign: 'center',
      border: '1px dashed rgba(255,255,255,0.12)', borderRadius: 3,
    }}>
      <Box sx={{ color: 'text.disabled', mb: 1.25, display: 'flex' }}>{icon}</Box>
      <Typography variant="subtitle1" sx={{ mb: 0.5 }}>{title}</Typography>
      {hint ? <Typography variant="body2" color="text.secondary" sx={{ maxWidth: 460, lineHeight: 1.6 }}>{hint}</Typography> : null}
      {action ? <Box sx={{ mt: 2 }}>{action}</Box> : null}
    </Box>
  );
}

// A subtle section label ("Filters", "Batch jobs") in small caps.
export function SectionLabel({ children, sx }: { children: React.ReactNode; sx?: SxProps<Theme> }) {
  return (
    <Typography
      component="div"
      sx={{
        fontSize: '0.72rem', fontWeight: 700, textTransform: 'uppercase',
        letterSpacing: '0.08em', color: 'text.secondary',
        display: 'flex', alignItems: 'center', gap: 1, ...sx,
      }}
    >{children}</Typography>
  );
}

// Consistent table container: rounded, bordered, soft background.
export function DataTable({ children, sx }: { children: React.ReactNode; sx?: SxProps<Theme> }) {
  return (
    <Box sx={{
      border: '1px solid rgba(255,255,255,0.07)',
      borderRadius: 3,
      overflow: 'hidden',
      background: 'rgba(255,255,255,0.012)',
      ...sx,
    }}>
      {children}
    </Box>
  );
}