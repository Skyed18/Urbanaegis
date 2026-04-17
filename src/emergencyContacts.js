import { STATE_COORDINATES } from './stateCoordinates.js';

const BASE_CONTACTS = [
  {
    id: 'erss',
    label: 'National Emergency Response Support (ERSS)',
    number: '112',
    description: 'Unified police, fire, and ambulance emergency response.',
  },
  {
    id: 'police',
    label: 'Police Control Room',
    number: '100',
    description: 'Direct police assistance line.',
  },
  {
    id: 'ambulance',
    label: 'Government Ambulance Service',
    number: '108',
    description: 'Emergency medical transport and support.',
  },
  {
    id: 'fire',
    label: 'Fire & Rescue Services',
    number: '101',
    description: 'Fire incidents and rescue response.',
  },
  {
    id: 'women',
    label: 'Women Helpline',
    number: '1091',
    description: 'Emergency support and protection for women.',
  },
  {
    id: 'child',
    label: 'Childline',
    number: '1098',
    description: '24x7 emergency support for children.',
  },
  {
    id: 'disaster',
    label: 'State Disaster Control Room',
    number: '1070',
    description: 'State-level disaster management support (where available).',
  },
  {
    id: 'district-disaster',
    label: 'District Disaster Helpline',
    number: '1077',
    description: 'District emergency operations support (where available).',
  },
];

export const STATE_OPTIONS = Object.keys(STATE_COORDINATES).sort((a, b) => a.localeCompare(b));

export const NATIONAL_HIGHWAY_CONTACTS = [
  {
    id: 'nhai-1033',
    label: 'NHAI Highway Emergency Helpline',
    number: '1033',
    description: 'National Highway emergency support (breakdown, crash, lane blockage, towing).',
  },
  {
    id: 'erss-112',
    label: 'ERSS National Emergency',
    number: '112',
    description: 'Unified emergency contact for police, ambulance, and fire while travelling.',
  },
  {
    id: 'ambulance-108',
    label: 'Highway Medical Emergency Ambulance',
    number: '108',
    description: 'Immediate medical response support on highways.',
  },
  {
    id: 'highway-police',
    label: 'Highway Police Assistance',
    number: '100',
    description: 'Law-and-order support and roadside safety intervention.',
  },
  {
    id: 'highway-fire',
    label: 'Highway Fire & Rescue',
    number: '101',
    description: 'Vehicle fire and rescue incidents on highway corridors.',
  },
];

export const STATE_EMERGENCY_CONTACTS = STATE_OPTIONS.reduce((contactsByState, stateName) => {
  contactsByState[stateName] = {
    state: stateName,
    contacts: BASE_CONTACTS.map((contact) => ({ ...contact })),
  };

  return contactsByState;
}, {});

export function getStateEmergencyContacts(stateName) {
  if (!stateName || !STATE_EMERGENCY_CONTACTS[stateName]) {
    return STATE_EMERGENCY_CONTACTS[STATE_OPTIONS[0]];
  }

  return STATE_EMERGENCY_CONTACTS[stateName];
}
