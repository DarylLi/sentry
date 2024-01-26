import type {DateString, MRI, PageFilters} from 'sentry/types';

export enum MetricDisplayType {
  LINE = 'line',
  AREA = 'area',
  BAR = 'bar',
}

export type MetricTag = {
  key: string;
};

export type SortState = {
  name: 'name' | 'avg' | 'min' | 'max' | 'sum' | undefined;
  order: 'asc' | 'desc';
};

export interface MetricWidgetQueryParams extends MetricsQuerySubject {
  displayType: MetricDisplayType;
  focusedSeries?: {
    seriesName: string;
    groupBy?: Record<string, string>;
  };
  highlightedSample?: string | null;
  powerUserMode?: boolean;
  showSummaryTable?: boolean;
  sort?: SortState;
}

export interface DdmQueryParams {
  widgets: string; // stringified json representation of MetricWidgetQueryParams
  end?: DateString;
  environment?: string[];
  project?: number[];
  start?: DateString;
  statsPeriod?: string | null;
  utc?: boolean | null;
}

export type MetricsQuery = {
  datetime: PageFilters['datetime'];
  environments: PageFilters['environments'];
  mri: MRI;
  projects: PageFilters['projects'];
  groupBy?: string[];
  op?: string;
  query?: string;
  title?: string;
};

export type MetricsQuerySubject = Pick<
  MetricsQuery,
  'mri' | 'op' | 'query' | 'groupBy' | 'title'
>;

export type MetricCodeLocationFrame = {
  absPath?: string;
  contextLine?: string;
  filename?: string;
  function?: string;
  lineNo?: number;
  module?: string;
  platform?: string;
  postContext?: string[];
  preContext?: string[];
};

export type MetricMetaCodeLocation = {
  mri: string;
  timestamp: number;
  codeLocations?: MetricCodeLocationFrame[];
  frames?: MetricCodeLocationFrame[];
  metricSpans?: MetricCorrelation[];
};

export type MetricCorrelation = {
  duration: number;
  metricSummaries: {
    spanId: string;
    count?: number;
    max?: number;
    min?: number;
    sum?: number;
  }[];
  profileId: string;
  projectId: number;
  segmentName: string;
  spansDetails: {
    spanDuration: number;
    spanId: string;
    spanTimestamp: string;
  }[];
  spansNumber: number;
  timestamp: string;
  traceId: string;
  transactionId: string;
  spansSummary?: {
    spanDuration: number;
    spanOp: string;
  }[];
};

export type MetricRange = {
  end?: DateString;
  max?: number;
  min?: number;
  start?: DateString;
};
