import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import { get as idbGet, set as idbSet, del as idbDel } from 'idb-keyval';
import type { AskEntry, GameSize, Role, Units } from '../engine/types';
import type { Strictness } from '../engine/candidates';

export type { Units };

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

/**
 * A shape drawn with the measuring tool.
 *
 * These are planning scratch, not game state: nothing here feeds the
 * elimination engine. They persist anyway, because a circle drawn to reason
 * about the next question is worth exactly as much an hour later, and the game
 * runs all day across a phone that will lock, sleep and reload.
 */
export type MeasureShape =
  | { id: string; kind: 'circle'; center: [number, number]; radiusM: number }
  | { id: string; kind: 'line'; points: [number, number][] };

export type MeasureState = {
  /** Which tool the next map tap feeds. 'off' returns taps to the game. */
  tool: 'off' | 'circle' | 'line';
  /** Radius for the next circle, in metres. Always metric internally. */
  radiusM: number;
  shapes: MeasureShape[];
  /** Points of the line being drawn, before it is committed. */
  draft: [number, number][];
};

type Settings = {
  gameSize: GameSize;
  strictness: Strictness;
  units: Units;
  /** House rule: use supervisor districts as the 4th administrative division. */
  supervisorDistrictsAsAdmin4: boolean;
  /**
   * Questions turned off before the round, by id — a house-rule opt-out
   * (a boundary type nobody wants to deal with, a rule the table dislikes,
   * anything). A disabled question is forced into the same null status as
   * one with no subject on the map: it sinks to the bottom of the Ask list
   * and can be hidden with `hideDeadQuestions`, and the seeker can still
   * only record it as null, never actually ask it.
   */
  disabledQuestionIds: string[];
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
  /**
   * Sink null/no-split questions to the bottom of the Ask list and, when on,
   * hide them entirely. A display preference, not a game rule — unlike
   * `settings`, it needs no pre-round agreement between players.
   */
  hideDeadQuestions: boolean;
  /**
   * Hider only: where the seekers started and ended a thermometer run.
   *
   * A thermometer is the one question the hider cannot answer from a single
   * seeker position — it needs both ends of the seekers' travel, which they
   * send over. So the hider places two points by hand, exactly as they would
   * with the measuring tool, and `arm` says which one the next map tap sets.
   */
  hiderThermo: { start?: [number, number]; end?: [number, number]; arm: 'none' | 'start' | 'end' };
  measure: MeasureState;
  /**
   * Questions being compared before one is actually asked, at most three.
   *
   * Asking is expensive — every question hands the hider cards — so the choice
   * of which to ask is the seeker's real decision. This is that decision held
   * in one place, rather than in the player's head.
   */
  plan: string[];
  /** Draw the plan's candidate regions on the map. */
  planOnMap: boolean;

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
  toggleHideDeadQuestions: () => void;
  armHiderThermo: (which: 'none' | 'start' | 'end') => void;
  placeHiderThermo: (ll: [number, number]) => void;
  clearHiderThermo: () => void;
  setMeasureTool: (t: MeasureState['tool']) => void;
  setMeasureRadius: (m: number) => void;
  measureTap: (ll: [number, number]) => void;
  finishMeasureLine: () => void;
  undoMeasurePoint: () => void;
  removeMeasureShape: (id: string) => void;
  clearMeasure: () => void;
  togglePlanQuestion: (questionId: string) => void;
  clearPlan: () => void;
  setPlanOnMap: (v: boolean) => void;
  toggleOverlay: (askId: string) => void;
  updateSettings: (patch: Partial<Settings>) => void;
  toggleQuestionDisabled: (questionId: string) => void;

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
        /**
         * Pare zones down by the station in the middle, not by the hider's
         * possible position anywhere in the circle.
         *
         * This is how the table plays it, and it is what makes the numbers in
         * the Ask list mean what they appear to mean: the split preview counts
         * centre points, so under the old default a question previewing "1 / 47"
         * would leave 48 zones standing and look broken. The trade-off is real
         * and stated in Map → settings — a hider standing near the edge of
         * their circle can truthfully give an answer that rules their own zone
         * out — and 'conservative' is still there for anyone who wants the
         * never-wrong reading.
         */
        strictness: 'strict',
        units: 'imperial',
        // Was dead until admin4 was wired up: no house rule anyone could
        // have actually chosen `false` against. Defaulting it on makes the
        // question live like every other POI-backed matching question.
        supervisorDistrictsAsAdmin4: true,
        disabledQuestionIds: [],
      },
      visibleLayers: [],
      hiddenOverlays: [],
      mapLayers: { outOfPlay: true, zoneBuffers: true, stationDots: true },
      manualLocation: { enabled: false },
      hiderPlaceTarget: 'me',
      armSeekerPin: false,
      sheetCollapsed: false,
      hideDeadQuestions: false,
      hiderThermo: { arm: 'none' },
      measure: { tool: 'off', radiusM: 500, shapes: [], draft: [] },
      plan: [],
      planOnMap: true,

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

      toggleHideDeadQuestions: () => set({ hideDeadQuestions: !get().hideDeadQuestions }),

      armHiderThermo: (arm) => set({ hiderThermo: { ...get().hiderThermo, arm } }),

      // Placing disarms: two taps in a row should not silently move the point
      // you just set, which is the failure the seeker pin had.
      placeHiderThermo: (ll) => {
        const t = get().hiderThermo;
        if (t.arm === 'none') return;
        set({ hiderThermo: { ...t, [t.arm]: ll, arm: 'none' } });
      },

      clearHiderThermo: () => set({ hiderThermo: { arm: 'none' } }),

      setMeasureTool: (tool) =>
        // Switching tools abandons a half-drawn line rather than silently
        // carrying its points into the next shape.
        set({ measure: { ...get().measure, tool, draft: [] } }),

      setMeasureRadius: (radiusM) => set({ measure: { ...get().measure, radiusM } }),

      measureTap: (ll) => {
        const m = get().measure;
        if (m.tool === 'circle') {
          const shape: MeasureShape = { id: uid(), kind: 'circle', center: ll, radiusM: m.radiusM };
          set({ measure: { ...m, shapes: [...m.shapes, shape] } });
        } else if (m.tool === 'line') {
          set({ measure: { ...m, draft: [...m.draft, ll] } });
        }
      },

      // A one-point line is a dot, not a measurement; drop it.
      finishMeasureLine: () => {
        const m = get().measure;
        if (m.draft.length < 2) { set({ measure: { ...m, draft: [] } }); return; }
        const shape: MeasureShape = { id: uid(), kind: 'line', points: m.draft };
        set({ measure: { ...m, shapes: [...m.shapes, shape], draft: [] } });
      },

      undoMeasurePoint: () =>
        set({ measure: { ...get().measure, draft: get().measure.draft.slice(0, -1) } }),

      removeMeasureShape: (id) =>
        set({ measure: { ...get().measure, shapes: get().measure.shapes.filter((s) => s.id !== id) } }),

      clearMeasure: () => set({ measure: { ...get().measure, shapes: [], draft: [] } }),

      /**
       * Three slots, and adding a fourth pushes the oldest out.
       *
       * The cap is the point of the feature: comparing everything is what the
       * question list already does. A shortlist you can hold in your head is
       * what actually gets a decision made inside the answer clock.
       */
      togglePlanQuestion: (questionId) => {
        const plan = get().plan;
        if (plan.includes(questionId)) set({ plan: plan.filter((id) => id !== questionId) });
        else set({ plan: [...plan, questionId].slice(-3) });
      },

      clearPlan: () => set({ plan: [] }),

      setPlanOnMap: (planOnMap) => set({ planOnMap }),

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

      toggleQuestionDisabled: (questionId) => {
        const { disabledQuestionIds } = get().settings;
        const next = disabledQuestionIds.includes(questionId)
          ? disabledQuestionIds.filter((id) => id !== questionId)
          : [...disabledQuestionIds, questionId];
        set({ settings: { ...get().settings, disabledQuestionIds: next } });
      },

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
      version: 3,
      /**
       * A stored setting outlives a change of default, so v1 devices would have
       * kept eliminating by the whole 500 m circle no matter what the code now
       * says. Move them, since the old value was never chosen — it was just
       * what shipped.
       */
      migrate: (persisted: any, version: number) => {
        if (version < 2 && persisted?.settings?.strictness === 'conservative') {
          persisted.settings.strictness = 'strict';
        }
        // `disabledQuestionIds` is read with `.includes()` throughout — a
        // missing array here (any device that persisted before this field
        // existed) would throw, not just show the wrong default.
        if (version < 3 && persisted?.settings && !Array.isArray(persisted.settings.disabledQuestionIds)) {
          persisted.settings.disabledQuestionIds = [];
        }
        return persisted;
      },
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
