import type { TimeValue } from "./time.ts";

export type SortOrder = "asc" | "desc";

/** A search over a time range. Queries use Loggly's Lucene-based search syntax. */
export interface SearchParams {
  /** Loggly search query. Defaults to "*" (all events). */
  query?: string;
  /** Start time. Defaults to "-24h". */
  from?: TimeValue;
  /** End time. Defaults to "now". */
  until?: TimeValue;
}

export interface IterateParams extends SearchParams {
  /** Events per page, from 1 to 1,000. Defaults to 50. */
  size?: number;
  /** Event order. Defaults to "desc" (newest first). */
  order?: SortOrder;
}

export interface CountParams extends SearchParams {
  /** Also return the total size of matching events. Slower. */
  includeVolume?: boolean;
}

export interface FacetParams extends SearchParams {
  /** Maximum number of values, from 1 to 300. Defaults to 10. */
  size?: number;
}

export interface FieldsParams extends SearchParams {
  /** Maximum number of field names, from 1 to 500. Defaults to 100. */
  size?: number;
}

export interface RequestOptions {
  signal?: AbortSignal;
}

/** One event. `event` contains the fields Loggly parsed (json, syslog, derived fields, ...). */
export interface LogEvent {
  id: string;
  /** Unix epoch milliseconds. */
  timestamp: number;
  logmsg: string;
  event: Record<string, unknown>;
  tags: string[];
  logtypes: string[];
  raw?: string;
  unparsed?: string;
}

export interface EventPage {
  events: LogEvent[];
  /** Opaque continuation URL. Loggly expires it ten minutes after the previous request. */
  next?: string;
}

export interface EventCount {
  count: number;
  /** Total bytes of matching events, when requested with includeVolume. */
  volumeBytes?: number;
}

export interface FacetTerm {
  term: string;
  count: number;
}

export interface FacetResult {
  field: string;
  /** Events matching the search, including events without this field. */
  totalEvents: number;
  /** Distinct values reported by Loggly. Loggly caps this at the requested size. */
  uniqueCount: number;
  terms: FacetTerm[];
  /** More values may exist than were returned: the list reached the requested size. */
  truncated: boolean;
}

export type VolumeGroup = "host" | "app" | "log_type" | "tag";
export type VolumeMeasurement = "count" | "volume_bytes";

export interface VolumeMetricsParams {
  from: TimeValue;
  until: TimeValue;
  groupBy?: VolumeGroup[];
  hosts?: string[];
  apps?: string[];
  measurementTypes?: VolumeMeasurement[];
}

/** One volume-metrics row. Dimensions are present only when grouped by them. */
export interface VolumeMetric {
  metric?: string;
  /** Epoch milliseconds. */
  start: number;
  /** Epoch milliseconds. */
  end: number;
  count?: number;
  volumeBytes?: number;
  host?: string;
  app?: string;
  logType?: string;
  tags?: string[];
}

/** Account details. Customer (ingestion) tokens are deliberately never exposed. */
export interface AccountInfo {
  subdomain: string;
  retentionDays?: number;
  volumeLimitMb?: number;
}
