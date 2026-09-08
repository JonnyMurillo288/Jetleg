import type { Feature, FeatureCollection, Polygon, MultiPolygon, Point, LineString, MultiLineString } from 'geojson';

export type Mode = 'rail' | 'metro' | 'bus' | 'cablecar' | 'ferry';
export type GameSize = 'small' | 'medium' | 'large';
export type Role = 'seeker' | 'hider';

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
  /** Points for POIs measured to their map icon; lines for coastline etc. */
  kind: 'point' | 'line';
  features: Feature<Point | LineString | MultiLineString>[];
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
