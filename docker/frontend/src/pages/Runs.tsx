import { useState, useEffect } from 'react';
import Typography from '@mui/material/Typography';
import Box from '@mui/material/Box';
import Table from '@mui/material/Table';
import TableBody from '@mui/material/TableBody';
import TableCell from '@mui/material/TableCell';
import TableHead from '@mui/material/TableHead';
import TableRow from '@mui/material/TableRow';
import Card from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import Chip from '@mui/material/Chip';

import { api } from '../api';

interface Run {
  id: number;
  name: string;
  status: string;
  llm_used: boolean;
  n_classified: number;
  n_mexican: number;
  n_latin_american: number;
  created_at: string;
  finished_at: string | null;
}

export default function Runs() {
  const [runs, setRuns] = useState<Run[]>([]);
  const [loading, setLoading] = useState(true);

  const load = async () => {
    try {
      const data = await api.runs();
      setRuns(Array.isArray(data) ? data : []);
    } catch (e) {
      console.error(e);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []);

  const statusColor = (s: string) => {
    if (s === 'completed') return 'success';
    if (s === 'running') return 'warning';
    if (s === 'failed') return 'error';
    return 'default';
  };

  return (
    <Box>
      <Typography variant="h5" gutterBottom>Classification runs</Typography>
      <Card variant="outlined">
        <CardContent>
          {loading ? <Typography>Loading…</Typography> : runs.length === 0 ? (
            <Typography color="text.secondary">No classification runs yet.</Typography>
          ) : (
            <Table size="small">
              <TableHead>
                <TableRow>
                  <TableCell>Name</TableCell>
                  <TableCell>Status</TableCell>
                  <TableCell>Strategy</TableCell>
                  <TableCell>Classified</TableCell>
                  <TableCell>Mexican</TableCell>
                  <TableCell>Lat-Am</TableCell>
                  <TableCell>LLM</TableCell>
                  <TableCell>Done</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {runs.map((r) => (
                  <TableRow key={r.id} hover>
                    <TableCell>{r.name}</TableCell>
                    <TableCell><Chip size="small" label={r.status} color={statusColor(r.status)} /></TableCell>
                    <TableCell>{r.strategy}</TableCell>
                    <TableCell>{r.n_classified}</TableCell>
                    <TableCell>{r.n_mexican}</TableCell>
                    <TableCell>{r.n_latin_american}</TableCell>
                    <TableCell>{r.llm_used ? 'yes' : 'no'}</TableCell>
                    <TableCell>{r.finished_at ? new Date(r.finished_at).toLocaleString() : '—'}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </Box>
  );
}
