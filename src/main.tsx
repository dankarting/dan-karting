import React from 'react';
import { createRoot } from 'react-dom/client';
import { FileRouter } from '@instinct/files';
import { App, PublicBoard, StaffGate } from './App';
import { JoinPage } from './Join';
import { CheckPage } from './Check';
import './style.css';

document.documentElement.dir = 'rtl';
document.documentElement.lang = 'he';

// The public website (default) shows the read-only timing board.
// Staff open the same address with ?staff and sign in to get the cashier / heats / track app.
// Customers check in from their phone with ?join (QR at the counter).
const q = new URLSearchParams(location.search);
const staff = q.has('staff');
createRoot(document.getElementById('root')!).render(q.has('check') ? <CheckPage /> : q.has('join') ? <JoinPage /> : staff ? <StaffGate><FileRouter><App /></FileRouter></StaffGate> : <PublicBoard />);
