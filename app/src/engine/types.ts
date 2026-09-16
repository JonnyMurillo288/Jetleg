import type { Feature, FeatureCollection, Polygon, MultiPolygon, Point, LineString, MultiLineString } from 'geojson';

export type Mode = 'rail' | 'metro' | 'bus' | 'cablecar' | 'ferry';
export type GameSize = 'small' | 'medium' | 'large';
export type Role = 'seeker' | 'hider';
export type Units = 'imperial' | 'metric';

export type LngLat = [number, number];

/** A hiding zone: a transit station plus the 500 m circle around it. */
export type Station = {
  id: string;
  name: string;
  lon: number;
  lat: number;
  modes: Mode[];
  routes: string[];
  nameLength: number;
};

export type Category = 'matching' | 'measuring' | 'radar' | 'thermometer' | 'photo' | 'tentacle';

/**
 * Answers, by category. `null` is its own answer: the rulebook says a question
 * whose subject does not exist inside the map returns null, that null counts as
 * an answered question, and the hider still draws cards.
 */
export type Answer =
  | { kind: 'yesno'; value: 'yes' | 'no' }
  | { kind: 'closerFurther'; value: 'closer' | 'further' }
  | { kind: 'hotterColder'; value: 'hotter' | 'colder' }
  | { kind: 'tentacle'; poiId: string | null } // null = "not within reach"
  | { kind: 'null' }
  | { kind: 'photo' }; // no geometry; recorded for the log only

export type AnswerKind = Answer['kind'];

/** One question in the catalog. The 80 live as data, not code. */
export type Question = {
  id: string;
  category: Category;
  /** The noun or value that fills the blank, e.g. "Park" or "2 km". */
  label: string;
  /** Full text as the seeker would say it. */
  text: string;
  /** Heading it sits under in the rulebook, e.g. "Places of Interest". */
  group: string;
  /** Key into the POI layer set, where the question references one. */
  layer?: string;
  /** Radar / thermometer / tentacle radius, in metres. */
  distanceM?: number;
  /**
   * Radar / thermometer only, and only when the tiers are not a plain unit
   * conversion of each other: the mile-native distanceM/label/text to use
   * when `settings.units === 'imperial'`. Both sides must still agree on a
   * unit system before the round, exactly like the admin4 house rule — the
   * distance itself changes here, not just how it is printed.
   */
  imperial?: { distanceM: number; label: string; text: string };
  /** Card reward, verbatim from the rulebook. */
  draw: string;
  /** Answer deadline in minutes. */
  timeLimitMin: number;
  /** Game sizes this question is available in. */
  sizes: GameSize[];
  answerKind: AnswerKind;
  /** Photo framing requirements. */
  spec?: string;
  /** Extra rule the seeker must honour when asking. */
  caveat?: string;
};

/** A question that has been asked and answered. The log is the source of truth. */
export type AskEntry = {
  id: string;
  questionId: string;
  askedAt: number;
  /** Where the seeker was standing. Auto-filled from GPS, always editable. */
  origin: LngLat;
  /** Thermometer only: where they ended up. */
  destination?: LngLat;
  /**
   * Radius chosen at ask time, in metres, for the questions that have no fixed
   * one — radar's "Choose". Without it the engine fell back to the question's
   * own `distanceM`, which for that question does not exist.
   */
  distanceM?: number;
  answer: Answer;
  note?: string;
  /** Excluded from elimination but kept in the log. */
  disabled?: boolean;
};

/** Why a question cannot usefully be asked right now. */
export type QuestionStatus =
  | { state: 'ok'; yesCount: number; noCount: number }
  | { state: 'null'; reason: string }
  | { state: 'useless'; reason: string; yesCount: number; noCount: number }
  | { state: 'unavailable'; reason: string };

export type PoiLayer = {
  key: string;
  label: string;
  /**
   * Points for POIs measured to their map icon; lines for coastline etc.;
   * polygon for a layer that already partitions the whole board (districts),
   * matched by point-in-polygon rather than nearest-feature.
   */
  kind: 'point' | 'line' | 'polygon';
  features: Feature<Point | LineString | MultiLineString | Polygon | MultiPolygon>[];
  /**
   * The layer's precomputed Voronoi cells, when it has them.
   *
   * The same file the map draws. A matching question *is* a question about
   * these cells, so the engine answering it with a separately computed shape is
   * how the map and the elimination came to disagree — visibly, on the boundary
   * of the de Young's cell. Carrying the cells on the layer makes the two the
   * same object rather than two things that ought to match.
   */
  cells?: FeatureCollection;
};

export type Boundary = Feature<Polygon | MultiPolygon>;
