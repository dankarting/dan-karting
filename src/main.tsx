import React from 'react';
import { createRoot } from 'react-dom/client';
import { FileRouter } from '@instinct/files';
import { App, PublicBoard, StaffGate } from './App';
import './style.css';

document.documentElement.dir = 'rtl';
document.documentElement.lang = 'he';

// The public website (default) shows the read-only venue screen (call-up / live timing / results).
// Staff open the same address with ?staff and sign in to get the marshal console (timing core + add-ons).
const staff = new URLSearchParams(location.search).has('staff');
createRoot(document.getElementById('root')!).render(staff ? <StaffGate><FileRouter><App /></FileRouter></StaffGate> : <PublicBoard />);
