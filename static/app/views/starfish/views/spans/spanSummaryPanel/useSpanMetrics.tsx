import {useQuery} from 'sentry/utils/queryClient';
import {HOST} from 'sentry/views/starfish/utils/constants';
import type {Span} from 'sentry/views/starfish/views/spans/spanSummaryPanel/types';

type Metrics = {
  first_seen: string;
  last_seen: string;
  total_time: number;
};

export const useSpanMetrics = (span?: Span, referrer = 'span-metrics') => {
  const query = span ? getQuery(span) : '';

  const {isLoading, error, data} = useQuery<Metrics[]>({
    queryKey: ['span-metrics', span?.group_id],
    queryFn: () =>
      fetch(`${HOST}/?query=${query}&referrer=${referrer}`).then(res => res.json()),
    retry: false,
    initialData: [],
    enabled: Boolean(span),
  });

  return {isLoading, error, data: data[0]};
};

const getQuery = (span: Pick<Span, 'group_id'>) => {
  return `
    SELECT
    min(timestamp) as first_seen,
    max(timestamp) as last_seen,
    sum(exclusive_time) as total_time
    FROM spans_experimental_starfish
    WHERE 1 == 1
    AND group_id = '${span.group_id}'
 `;
};
