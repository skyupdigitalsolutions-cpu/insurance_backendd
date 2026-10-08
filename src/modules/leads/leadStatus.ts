import type { LeadStatus } from './lead.model.js';

// The lead state machine: which status can follow which (same as the app shows)
export const LEAD_TRANSITIONS: Record<LeadStatus, LeadStatus[]> = {
  NEW: ['CONTACTED', 'LOST'],
  CONTACTED: ['QUALIFIED', 'FOLLOW_UP', 'LOST'],
  QUALIFIED: ['QUOTATION', 'FOLLOW_UP', 'LOST'],
  QUOTATION: ['FOLLOW_UP', 'CONVERTED', 'LOST'],
  FOLLOW_UP: ['QUOTATION', 'CONVERTED', 'LOST'],
  CONVERTED: [],
  LOST: ['NEW'], // "Reopen"
};

// A lead can become a customer once it is qualified
export const CONVERTIBLE: LeadStatus[] = ['QUALIFIED', 'QUOTATION', 'FOLLOW_UP'];
