import React from 'react';
import { createRoot } from 'react-dom/client';
import { FileRouter } from '@instinct/files';
import { App, PublicBoard } from './App';
import './style.css';

document.documentElement.dir = 'rtl';
document.documentElement.lang = 'he';

// The public website (default) shows the read-only timing board.
// Staff open the same address with ?staff to get the cashier / heats / track app.
const staff = new URLSearchParams(location.search).has('staff');
createRoot(document.getElementById('root')!).render(staff ? <FileRouter><App /></FileRouter> : <PublicBoard />);
