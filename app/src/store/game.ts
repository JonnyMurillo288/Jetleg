import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import { get as idbGet, set as idbSet, del as idbDel } from 'idb-keyval';
import type { AskEntry, GameSize, Role } from '../engine/types';
import type { Strictness } from '../engine/candidates';

/**
 * All state is local to this device and this player. There is no server and no
 * sync: a hider and a seeker running the app never see each other's data.
 *
 * Rounds are namespaced by role, so hiding in round 1 and seeking in round 2
 * keeps both cleanly separated.
 */

export type Round = {
  id: string;
  role: Role;
  label: string;
  startedAt: number;
  endedAt?: number;
  /** Seeker: the ask log. Append-only; undo removes the last entry. */
  asks: AskEntry[];
  /** Hider: the station whose 500 m circle they claimed. */
  hiderStationId?: string;
  /**
   * Hider: where the seekers are.
   *
   * The rulebook has seekers run trackers the hider can follow, so this is
   * information the hider genuinely has — and it is what makes it possible to
   * replay their own answers and see what the seekers can deduce.
   */
  seekerPin?: [number, number];
};

/** The three things the map overlay can show. */
export type MapLayers = {
  /** Shade everywhere the answers have ruled out. */
  outOfPlay: boolean;
  /** The 500 m hiding-zone circles. */
  zoneBuffers: boolean;
  /** Station points. */
  stationDots: boolean;
};

type Settings = {
  gameSize: GameSize;
  strictness: Strictness;
  units: 'imperial' | 'metric';
  /** House rule: use supervisor districts as the 4th administrative division. */
  supervisorDistrictsAsAdmin4: boolean;
};

type State = {
  role: Role;
  rounds: Round[];
  activeRoundId: string | null;
  settings: Settings;
  visibleLayers: string[];
  /** Overlay ids the player has hidden without deleting the ask. */
  hiddenOverlays: string[];
  mapLayers: MapLayers;
  /**
   * Manual position, for playing without GPS.
   *
   * Useful when the fix is bad (underground, urban canyon), when the phone is
   * conserving battery over an all-day game, or when logging a question after
   * the fact from somewhere else. While enabled the GPS watch is stopped
   * entirely rather than merely ignored.
   */
  manualLocation: { enabled: boolean; coords?: [number, number] };
  /**
   * Hider only, and only while manual location is on: what a tap-and-hold
   * places. With manual mode enabled the hider has two points to position —
   * their own and the seekers' — and a long press cannot mean both.
   */
  hiderPlaceTarget: 'me' | 'seekers';
  /**
   * Hider: the next map tap places the seekers' pin, whatever it lands on.
   *
   * Without this, the pin was effectively unplaceable. The station hit targets
   * are 12 px at every zoom, so at city-wide zoom 276 of them blanket the map
   * and a tap almost always claimed a station instead.
   */
  armSeekerPin: boolean;
  /** Collapsed sheet gives the map most of the screen. */
  sheetCollapsed: boolean;

  setRole: (r: Role) => void;
  startRound: (label?: string) => void;
  endRound: () => void;
  setActiveRound: (id: string | null) => void;
  deleteRound: (id: string) => void;

  addAsk: (a: AskEntry) => void;
  updateAsk: (id: string, patch: Partial<AskEntry>) => void;
  removeAsk: (id: string) => void;
  undoLastAsk: () => void;

  setHiderStation: (id: string | undefined) => void;
  setSeekerPin: (ll: [number, number] | undefined) => void;
  toggleLayer: (key: string) => void;
  toggleMapLayer: (key: keyof MapLayers) => void;
  setManualEnabled: (enabled: boolean, seed?: [number, number]) => void;
  setManualCoords: (coords: [number, number]) => void;
  setHiderPlaceTarget: (t: 'me' | 'seekers') => void;
  setArmSeekerPin: (v: boolean) => void;
  setSheetCollapsed: (v: boolean) => void;
  toggleOverlay: (askId: string) => void;
  updateSettings: (patch: Partial<Settings>) => void;

  exportJSON: () => string;
  importJSON: (raw: string) => { ok: true } | { ok: false; error: string };
};

const idbStorage = {
  getItem: async (name: string) => (await idbGet(name)) ?? null,
  setItem: async (name: string, value: string) => { await idbSet(name, value); },
  removeItem: async (name: string) => { await idbDel(name); },
};

const uid = () =>
  globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

export const useGame = create<State>()(
  persist(
    (set, get) => ({
      role: 'seeker',
      rounds: [],
      activeRoundId: null,
      settings: {
        // SF is a hybrid against the rulebook's table: ~276 stations says
        // medium, 120 km² says small. Station count drives search complexity,
        // and the 500 m zone radius is identical either way.
        gameSize: 'medium',
        strictness: 'conservative',
        units: 'imperial',
        supervisorDistrictsAsAdmin4: false,
      },
      visibleLayers: [],
      hiddenOverlays: [],
      mapLayers: { outOfPlay: true, zoneBuffers: true, stationDots: true },
      manualLocation: { enabled: false },
      hiderPlaceTarget: 'me',
      armSeekerPin: false,
      sheetCollapsed: false,

      setRole: (role) => {
        const active = get().rounds.find((r) => r.id === get().activeRoundId);
        set({ role, activeRoundId: active?.role === role ? active.id : null });
      },

      startRound: (label) => {
        const role = get().role;
        const n = get().rounds.filter((r) => r.role === role).length + 1;
        const round: Round = {
          id: uid(),
          role,
          label: label ?? `${role === 'seeker' ? 'Seeking' : 'Hiding'} round ${n}`,
          startedAt: Date.now(),
          asks: [],
        };
        set({ rounds: [...get().rounds, round], activeRoundId: round.id });
      },

      endRound: () => {
        const id = get().activeRoundId;
        if (!id) return;
        set({ rounds: get().rounds.map((r) => (r.id === id ? { ...r, endedAt: Date.now() } : r)) });
      },

      setActiveRound: (activeRoundId) => set({ activeRoundId }),

      deleteRound: (id) =>
        set({
          rounds: get().rounds.filter((r) => r.id !== id),
          activeRoundId: get().activeRoundId === id ? null : get().activeRoundId,
        }),

      addAsk: (a) => patchRound(set, get, (r) => ({ ...r, asks: [...r.asks, a] })),

      updateAsk: (id, patch) =>
        patchRound(set, get, (r) => ({
          ...r,
          asks: r.asks.map((a) => (a.id === id ? { ...a, ...patch } : a)),
        })),

      removeAsk: (id) =>
        patchRound(set, get, (r) => ({ ...r, asks: r.asks.filter((a) => a.id !== id) })),

      undoLastAsk: () => patchRound(set, get, (r) => ({ ...r, asks: r.asks.slice(0, -1) })),

      setHiderStation: (hiderStationId) => patchRound(set, get, (r) => ({ ...r, hiderStationId })),

      setSeekerPin: (seekerPin) => {
        set({ armSeekerPin: false });
        patchRound(set, get, (r) => ({ ...r, seekerPin }));
      },

      toggleMapLayer: (key) =>
        set({ mapLayers: { ...get().mapLayers, [key]: !get().mapLayers[key] } }),

      setSheetCollapsed: (sheetCollapsed) => set({ sheetCollapsed }),

      // Seed from the last GPS fix so switching to manual starts somewhere
      // sensible rather than nowhere.
      setManualEnabled: (enabled, seed) =>
        set({ manualLocation: { enabled, coords: get().manualLocation.coords ?? seed } }),

      setManualCoords: (coords) =>
        set({ manualLocation: { ...get().manualLocation, coords } }),

      setHiderPlaceTarget: (hiderPlaceTarget) => set({ hiderPlaceTarget }),

      setArmSeekerPin: (armSeekerPin) => set({ armSeekerPin }),

      toggleLayer: (key) => {
        const v = get().visibleLayers;
        set({ visibleLayers: v.includes(key) ? v.filter((k) => k !== key) : [...v, key] });
      },

      toggleOverlay: (askId) => {
        const v = get().hiddenOverlays;
        set({ hiddenOverlays: v.includes(askId) ? v.filter((k) => k !== askId) : [...v, askId] });
      },

      updateSettings: (patch) => set({ settings: { ...get().settings, ...patch } }),

      exportJSON: () => {
        const { rounds, settings, role } = get();
        return JSON.stringify({ app: 'jetleg-sf', version: 1, exportedAt: Date.now(), role, settings, rounds }, null, 2);
      },

      importJSON: (raw) => {
        try {
          const doc = JSON.parse(raw);
          if (doc.app !== 'jetleg-sf') return { ok: false, error: 'Not a JetLeg export file.' };
          if (!Array.isArray(doc.rounds)) return { ok: false, error: 'No rounds in file.' };
          // Merge rather than replace, so importing a backup never destroys
          // rounds recorded on this device since the export.
          const existing = new Set(get().rounds.map((r) => r.id));
          const incoming = (doc.rounds as Round[]).filter((r) => !existing.has(r.id));
          set({
            rounds: [...get().rounds, ...incoming],
            settings: { ...get().settings, ...(doc.settings ?? {}) },
          });
          return { ok: true };
        } catch (e) {
          return { ok: false, error: e instanceof Error ? e.message : 'Could not parse file.' };
        }
      },
    }),
    {
      name: 'jetleg-sf',
      storage: createJSONStorage(() => idbStorage),
      version: 1,
    },
  ),
);

function patchRound(
  set: (p: Partial<State>) => void,
  get: () => State,
  fn: (r: Round) => Round,
) {
  const id = get().activeRoundId;
  if (!id) return;
  set({ rounds: get().rounds.map((r) => (r.id === id ? fn(r) : r)) });
}

export const useActiveRound = (): Round | null => {
  const rounds = useGame((s) => s.rounds);
  const id = useGame((s) => s.activeRoundId);
  return rounds.find((r) => r.id === id) ?? null;
};

export const newAskId = uid;

/**
 * Ask persistent storage for a durable bucket.
 *
 * Without this, iOS Safari evicts IndexedDB under storage pressure — which for
 * an all-day game means losing the round. The grant usually requires the app to
 * be installed to the home screen.
 */
export async function requestPersistence(): Promise<boolean> {
  if (!navigator.storage?.persist) return false;
  if (await navigator.storage.persisted?.()) return true;
  return navigator.storage.persist();
}
