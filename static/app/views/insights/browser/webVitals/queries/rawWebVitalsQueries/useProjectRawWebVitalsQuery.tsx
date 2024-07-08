import type {Tag} from 'sentry/types';
import {useDiscoverQuery} from 'sentry/utils/discover/discoverQuery';
import EventView from 'sentry/utils/discover/eventView';
import {DiscoverDatasets} from 'sentry/utils/discover/types';
import {MutableSearch} from 'sentry/utils/tokenizeSearch';
import {useLocation} from 'sentry/utils/useLocation';
import useOrganization from 'sentry/utils/useOrganization';
import usePageFilters from 'sentry/utils/usePageFilters';
import {DEFAULT_QUERY_FILTER} from 'sentry/views/insights/browser/webVitals/settings';
import {BrowserType} from 'sentry/views/insights/browser/webVitals/utils/queryParameterDecoders/browserType';
import {SpanIndexedField} from 'sentry/views/insights/types';

type Props = {
  browserType?: BrowserType;
  dataset?: DiscoverDatasets;
  tag?: Tag;
  transaction?: string;
};

export const useProjectRawWebVitalsQuery = ({
  transaction,
  tag,
  dataset,
  browserType,
}: Props = {}) => {
  const organization = useOrganization();
  const pageFilters = usePageFilters();
  const location = useLocation();
  const search = new MutableSearch([]);
  if (transaction) {
    search.addFilterValue('transaction', transaction);
  }
  if (tag) {
    search.addFilterValue(tag.key, tag.name);
  }
  if (browserType !== undefined && browserType !== BrowserType.ALL) {
    search.addFilterValue(SpanIndexedField.BROWSER_NAME, browserType);
  }

  const projectEventView = EventView.fromNewQueryWithPageFilters(
    {
      fields: [
        'p75(measurements.lcp)',
        'p75(measurements.fcp)',
        'p75(measurements.cls)',
        'p75(measurements.ttfb)',
        'p75(measurements.inp)',
        'p75(transaction.duration)',
        'count_web_vitals(measurements.lcp, any)',
        'count_web_vitals(measurements.fcp, any)',
        'count_web_vitals(measurements.cls, any)',
        'count_web_vitals(measurements.ttfb, any)',
        'count_web_vitals(measurements.inp, any)',
        'count()',
      ],
      name: 'Web Vitals',
      query: [DEFAULT_QUERY_FILTER, search.formatString()].join(' ').trim(),
      version: 2,
      dataset: dataset ?? DiscoverDatasets.METRICS,
    },
    pageFilters.selection
  );

  const result = useDiscoverQuery({
    eventView: projectEventView,
    limit: 50,
    location,
    orgSlug: organization.slug,
    cursor: '',
    options: {
      refetchOnWindowFocus: false,
    },
    skipAbort: true,
    referrer: 'api.performance.browser.web-vitals.project',
  });
  return result;
};
