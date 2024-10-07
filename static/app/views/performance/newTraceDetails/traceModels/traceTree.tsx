import * as Sentry from '@sentry/react';
import type {Location} from 'history';
import * as qs from 'query-string';

import type {Client} from 'sentry/api';
import type {RawSpanType} from 'sentry/components/events/interfaces/spans/types';
import type {Event, EventTransaction, Measurement} from 'sentry/types/event';
import type {Organization} from 'sentry/types/organization';
import {MobileVital, WebVital} from 'sentry/utils/fields';
import type {
  TraceError as TraceErrorType,
  TraceFullDetailed,
  TracePerformanceIssue as TracePerformanceIssueType,
  TraceSplitResults,
} from 'sentry/utils/performance/quickTrace/types';
import {
  MOBILE_VITAL_DETAILS,
  WEB_VITAL_DETAILS,
} from 'sentry/utils/performance/vitals/constants';
import type {Vital} from 'sentry/utils/performance/vitals/types';
import type {ReplayTrace} from 'sentry/views/replays/detail/trace/useReplayTraces';
import type {ReplayRecord} from 'sentry/views/replays/types';

import {isRootTransaction} from '../../traceDetails/utils';
import {getTraceQueryParams} from '../traceApi/useTrace';
import type {TraceMetaQueryResults} from '../traceApi/useTraceMeta';
import {
  getPageloadTransactionChildCount,
  isAutogroupedNode,
  isBrowserRequestSpan,
  isJavascriptSDKTransaction,
  isMissingInstrumentationNode,
  isPageloadTransactionNode,
  isParentAutogroupedNode,
  isRootNode,
  isServerRequestHandlerTransactionNode,
  isSiblingAutogroupedNode,
  isSpanNode,
  isTraceErrorNode,
  isTraceNode,
  isTransactionNode,
  shouldAddMissingInstrumentationSpan,
} from '../traceGuards';

import {makeExampleTrace} from './makeExampleTrace';
import {
  insertMissingInstrumentationSpan,
  type MissingInstrumentationNode,
  shouldInsertMissingInstrumentationSpan,
} from './missingInstrumentationNode';
import {ParentAutogroupNode} from './parentAutogroupNode';
import {SiblingAutogroupNode} from './siblingAutogroupNode';
import {TraceTreeEventDispatcher} from './traceTreeEventDispatcher';
import {TraceTreeNode} from './traceTreeNode';
import {cloneTraceTreeNode} from './traceTreeNodeUtils';
import {
  getRelatedPerformanceIssuesFromTransaction,
  getRelatedSpanErrorsFromTransaction,
} from './traceTreeUtils';

/**
 *
 * This file implements the tree data structure that is used to represent a trace. We do
 * this both for performance reasons as well as flexibility. The requirement for a tree
 * is to support incremental patching and updates. This is important because we want to
 * be able to fetch more data as the user interacts with the tree, and we want to be able
 * efficiently update the tree as we receive more data.
 *
 * The trace is represented as a tree with different node value types (transaction or span)
 * Each tree node contains a reference to its parent and a list of references to its children,
 * as well as a reference to the value that the node holds. Each node also contains
 * some meta data and state about the node, such as if it is expanded or zoomed in. The benefit
 * of abstracting parts of the UI state is that the tree will persist user actions such as expanding
 * or collapsing nodes which would have otherwise been lost when individual nodes are remounted in the tree.
 *
 * Each tree holds a list reference, which is a live reference to a flattened representation
 * of the tree (used to render the tree in the UI). Since the list is mutable (and we want to keep it that way for performance
 * reasons as we want to support mutations on traces with ~100k+ nodes), callers need to manage reactivity themselves.
 *
 * An alternative, but not recommended approach is to call build() on the tree after each mutation,
 * which will iterate over all of the children and build a fresh list reference.
 *
 * In most cases, the initial tree is a list of transactions containing other transactions. Each transaction can
 * then be expanded into a list of spans which can also in some cases be expanded.
 *
 *  - trace                                          - trace
 *   |- parent transaction     --> when expanding     |- parent transaction
 *    |- child transaction                             |- span
 *                                                      |- span                     this used to be a transaction,
 *                                                     |- child transaction span <- but is now be a list of spans
 *                                                     |- span                      belonging to the transaction
 *                                                                                  this results in child txns to be lost,
 *                                                                                  which is a confusing user experience
 *
 * The tree supports autogrouping of spans vertically or as siblings. When that happens, a autogrouped node of either a vertical or
 * sibling type is inserted as an intermediary node. In the vertical case, the autogrouped node
 * holds the reference to the head and tail of the autogrouped sequence. In the sibling case, the autogrouped node
 * holds a reference to the children that are part of the autogrouped sequence. When expanding and collapsing these nodes,
 * the tree perform a reference swap to either point to the head (when expanded) or tail (when collapsed) of the autogrouped sequence.
 *
 * In vertical grouping case, the following happens:
 *
 * - root                                              - root
 *  - trace                                             - trace
 *  |- transaction                                       |- transaction
 *   |- span 1   <-|  these become autogrouped             |- autogrouped (head=span1, tail=span3, children points to children of tail)
 *    |- span 2    |- as they are inserted into             |- other span (parent points to autogrouped node)
 *     |- span 3 <-|  the tree.
 *      |- other span
 *
 * When the autogrouped node is expanded the UI needs to show the entire collapsed chain, so we swap the tail children to point
 * back to the tail, and have autogrouped node point to its head as the children.
 *
 * - root                                                             - root
 *  - trace                                                            - trace
 *  |- transaction                                                     |- transaction
 *   |- autogrouped (head=span1, tail=span3) <- when expanding          |- autogrouped (head=span1, tail=span3, children points to head)
 *    | other span (paren points to autogrouped)                         |- span 1 (head)
 *                                                                        |- span 2
 *                                                                         |- span 3 (tail)
 *                                                                          |- other span (children of tail, parent points to tail)
 *
 * Notes and improvements:
 * - the notion of expanded and zoomed is confusing, they stand for the same idea from a UI pov
 * - there is an annoying thing wrt span and transaction nodes where we either store data on _children or _spanChildren
 *   this is because we want to be able to store both transaction and span nodes in the same tree, but it makes for an
 *   annoying API. A better design would have been to create an invisible meta node that just points to the correct children
 * - instead of storing span children separately, we should have meta tree nodes that handle pointing to the correct children
 */

export declare namespace TraceTree {
  interface TraceTreeEvents {
    ['trace timeline change']: (view: [number, number]) => void;
  }

  // Raw node values
  interface RawSpan extends RawSpanType {}
  interface Transaction extends TraceFullDetailed {
    profiler_id: string;
    sdk_name: string;
  }
  interface Span extends RawSpan {
    childTransactions: TraceTreeNode<TraceTree.Transaction>[];
    event: EventTransaction;
    measurements?: Record<string, Measurement>;
  }
  type Trace = TraceSplitResults<Transaction>;
  type TraceError = TraceErrorType;
  type TracePerformanceIssue = TracePerformanceIssueType;
  type Profile = {profile_id: string};
  type Root = null;

  // All possible node value types
  type NodeValue =
    | Trace
    | Transaction
    | TraceError
    | Span
    | MissingInstrumentationSpan
    | SiblingAutogroup
    | ChildrenAutogroup
    | Root;

  // Node types
  interface MissingInstrumentationSpan {
    start_timestamp: number;
    timestamp: number;
    type: 'missing_instrumentation';
  }
  interface SiblingAutogroup extends RawSpan {
    autogrouped_by: {
      description: string;
      op: string;
    };
  }

  interface ChildrenAutogroup extends RawSpan {
    autogrouped_by: {
      op: string;
    };
  }

  // All possible node types
  type Node =
    | TraceTreeNode<NodeValue>
    | ParentAutogroupNode
    | SiblingAutogroupNode
    | MissingInstrumentationNode;

  type NodePath =
    `${'txn' | 'span' | 'ag' | 'trace' | 'ms' | 'error' | 'empty'}-${string}`;

  type Metadata = {
    event_id: string | undefined;
    project_slug: string | undefined;
  };

  type Indicator = {
    duration: number;
    label: string;
    measurement: Measurement;
    poor: boolean;
    start: number;
    type: 'cls' | 'fcp' | 'fp' | 'lcp' | 'ttfb';
  };

  type CollectedVital = {key: string; measurement: Measurement};
}

export enum TraceShape {
  ONE_ROOT = 'one_root',
  NO_ROOT = 'no_root',
  BROWSER_MULTIPLE_ROOTS = 'browser_multiple_roots',
  MULTIPLE_ROOTS = 'multiple_roots',
  BROKEN_SUBTRACES = 'broken_subtraces',
  ONLY_ERRORS = 'only_errors',
  EMPTY_TRACE = 'empty_trace',
}

export type ViewManagerScrollToOptions = {
  api: Client;
  organization: Organization;
};

function fetchTransactionSpans(
  api: Client,
  organization: Organization,
  project_slug: string,
  event_id: string
): Promise<EventTransaction> {
  return api.requestPromise(
    `/organizations/${organization.slug}/events/${project_slug}:${event_id}/?averageColumn=span.self_time&averageColumn=span.duration`
  );
}

function measurementToTimestamp(
  start_timestamp: number,
  measurement: number,
  unit: string
) {
  if (unit === 'second') {
    return start_timestamp + measurement;
  }
  if (unit === 'millisecond') {
    return start_timestamp + measurement / 1e3;
  }
  if (unit === 'nanosecond') {
    return start_timestamp + measurement / 1e9;
  }
  throw new TypeError(`Unsupported measurement unit', ${unit}`);
}

function startTimestamp(node: TraceTreeNode<TraceTree.NodeValue>) {
  if (node.space) {
    return node.space[0];
  }

  if (isTraceNode(node)) {
    return 0;
  }
  if (isSpanNode(node)) {
    return node.value.start_timestamp;
  }
  if (isTransactionNode(node)) {
    return node.value.start_timestamp;
  }
  if (isMissingInstrumentationNode(node)) {
    return node.previous.value.timestamp;
  }
  return 0;
}

function chronologicalSort(
  a: TraceTreeNode<TraceTree.NodeValue>,
  b: TraceTreeNode<TraceTree.NodeValue>
) {
  return startTimestamp(a) - startTimestamp(b);
}

// cls is not included as it is a cumulative layout shift and not a single point in time
const RENDERABLE_MEASUREMENTS = [
  WebVital.TTFB,
  WebVital.FP,
  WebVital.FCP,
  WebVital.LCP,
  MobileVital.TIME_TO_FULL_DISPLAY,
  MobileVital.TIME_TO_INITIAL_DISPLAY,
]
  .map(n => n.replace('measurements.', ''))
  .reduce((acc, curr) => {
    acc[curr] = true;
    return acc;
  }, {});

const WEB_VITALS = [
  WebVital.TTFB,
  WebVital.FP,
  WebVital.FCP,
  WebVital.LCP,
  WebVital.CLS,
  WebVital.FID,
  WebVital.INP,
  WebVital.REQUEST_TIME,
].map(n => n.replace('measurements.', ''));

const MOBILE_VITALS = [
  MobileVital.APP_START_COLD,
  MobileVital.APP_START_WARM,
  MobileVital.TIME_TO_INITIAL_DISPLAY,
  MobileVital.TIME_TO_FULL_DISPLAY,
  MobileVital.FRAMES_TOTAL,
  MobileVital.FRAMES_SLOW,
  MobileVital.FRAMES_FROZEN,
  MobileVital.FRAMES_SLOW_RATE,
  MobileVital.FRAMES_FROZEN_RATE,
  MobileVital.STALL_COUNT,
  MobileVital.STALL_TOTAL_TIME,
  MobileVital.STALL_LONGEST_TIME,
  MobileVital.STALL_PERCENTAGE,
].map(n => n.replace('measurements.', ''));

const WEB_VITALS_LOOKUP = new Set<string>(WEB_VITALS);
const MOBILE_VITALS_LOOKUP = new Set<string>(MOBILE_VITALS);

const COLLECTABLE_MEASUREMENTS = [...WEB_VITALS, ...MOBILE_VITALS].map(n =>
  n.replace('measurements.', '')
);

const MEASUREMENT_ACRONYM_MAPPING = {
  [MobileVital.TIME_TO_FULL_DISPLAY.replace('measurements.', '')]: 'TTFD',
  [MobileVital.TIME_TO_INITIAL_DISPLAY.replace('measurements.', '')]: 'TTID',
};

const MEASUREMENT_THRESHOLDS = {
  [WebVital.TTFB.replace('measurements.', '')]: 600,
  [WebVital.FP.replace('measurements.', '')]: 3000,
  [WebVital.FCP.replace('measurements.', '')]: 3000,
  [WebVital.LCP.replace('measurements.', '')]: 4000,
  [MobileVital.TIME_TO_INITIAL_DISPLAY.replace('measurements.', '')]: 2000,
};

export const TRACE_MEASUREMENT_LOOKUP: Record<string, Vital> = {};

for (const key in {...MOBILE_VITAL_DETAILS, ...WEB_VITAL_DETAILS}) {
  TRACE_MEASUREMENT_LOOKUP[key.replace('measurements.', '')] = {
    ...MOBILE_VITAL_DETAILS[key],
    ...WEB_VITAL_DETAILS[key],
  };
}

function fetchTrace(
  api: Client,
  params: {
    orgSlug: string;
    query: string;
    traceId: string;
  }
): Promise<TraceSplitResults<TraceTree.Transaction>> {
  return api.requestPromise(
    `/organizations/${params.orgSlug}/events-trace/${params.traceId}/?${params.query}`
  );
}

export class TraceTree extends TraceTreeEventDispatcher {
  // @TODO remove this
  eventsCount: number = 0;

  type: 'loading' | 'empty' | 'error' | 'trace' = 'trace';
  root: TraceTreeNode<null> = TraceTreeNode.Root();

  vital_types: Set<'web' | 'mobile'> = new Set();
  vitals = new Map<TraceTreeNode<TraceTree.NodeValue>, TraceTree.CollectedVital[]>();

  profiled_events = new Set<TraceTreeNode<TraceTree.NodeValue>>();
  indicators: TraceTree.Indicator[] = [];

  project_ids = new Set<number>();
  list: TraceTreeNode<TraceTree.NodeValue>[] = [];

  private _spanPromises: Map<string, Promise<Event>> = new Map();

  static Empty() {
    const tree = new TraceTree().build();
    tree.type = 'empty';
    return tree;
  }

  static Loading(metadata: TraceTree.Metadata, tree?: TraceTree | null): TraceTree {
    const t = tree ? TraceTree.FromTree(tree) : makeExampleTrace(metadata);
    t.type = 'loading';
    return t;
  }

  static Error(metadata: TraceTree.Metadata, tree?: TraceTree | null): TraceTree {
    const t = tree ? TraceTree.FromTree(tree) : makeExampleTrace(metadata);
    t.type = 'error';
    return t;
  }

  static FromTree(tree: TraceTree): TraceTree {
    const newTree = new TraceTree();
    newTree.root = cloneTraceTreeNode(tree.root) as TraceTreeNode<null>;
    newTree.indicators = tree.indicators;
    newTree.list = tree.list;
    return newTree;
  }

  static FromTrace(
    trace: TraceTree.Trace,
    metaResults: TraceMetaQueryResults | null,
    replayRecord: ReplayRecord | null
  ): TraceTree {
    const tree = new TraceTree();

    let traceStart = Number.POSITIVE_INFINITY;
    let traceEnd = Number.NEGATIVE_INFINITY;

    const traceNode = new TraceTreeNode<TraceTree.Trace>(tree.root, trace, {
      event_id: undefined,
      project_slug: undefined,
    });

    tree.root.children.push(traceNode);

    function visit(
      parent: TraceTreeNode<TraceTree.NodeValue | null>,
      value: TraceTree.Transaction | TraceTree.TraceError
    ) {
      const node = new TraceTreeNode(parent, value, {
        project_slug:
          value && 'project_slug' in value
            ? value.project_slug
            : parent.metadata.project_slug ?? parent?.metadata.project_slug,
        event_id:
          value && 'event_id' in value
            ? value.event_id
            : parent.metadata.event_id ?? parent?.metadata.project_slug,
      });

      // We check for at least 2 spans because the first span is the transaction itself.
      if (isTransactionNode(node)) {
        const spanChildrenCount =
          metaResults?.data?.transactiontoSpanChildrenCount[node.value.event_id];
        node.canFetch = spanChildrenCount !== undefined ? spanChildrenCount >= 2 : true;

        for (const error of node.value.errors) {
          traceNode.errors.add(error);
        }

        for (const performanceIssue of node.value.performance_issues) {
          traceNode.performance_issues.add(performanceIssue);
        }
      } else if (isTraceErrorNode(node)) {
        traceNode.errors.add(node.value);
      }

      tree.eventsCount += 1;
      tree.project_ids.add(node.value.project_id);

      if (node.profiles.length > 0) {
        tree.profiled_events.add(node);
      }

      if (parent) {
        parent.children.push(node);
      }

      // Track min trace start and end timestamp.
      if ('start_timestamp' in node.value && node.value.start_timestamp < traceStart) {
        traceStart = node.value.start_timestamp;
      }
      if ('timestamp' in value && typeof value.timestamp === 'number') {
        // Errors don't have 'start_timestamp', so we adjust traceStart
        // with an errors 'timestamp'
        if (!isTransactionNode(node)) {
          traceStart = Math.min(value.timestamp, traceStart);
        }

        traceEnd = Math.max(value.timestamp, traceEnd);
      }

      if (value && 'measurements' in value) {
        collectMeasurements(
          node,
          traceStart,
          value.measurements as Record<string, Measurement>,
          tree.vitals,
          tree.vital_types,
          tree.indicators
        );
      }

      if (
        isPageloadTransactionNode(node) &&
        isServerRequestHandlerTransactionNode(parent) &&
        getPageloadTransactionChildCount(parent) === 1
      ) {
        // The swap can occur at a later point when new transactions are fetched,
        // which means we need to invalidate the tree and re-render the UI.
        TraceTree.Swap({parent, child: node, reason: 'pageload server handler'});
        TraceTree.invalidate(parent, true);
        TraceTree.invalidate(node, true);
      }

      if (node.value && 'children' in node.value) {
        for (const child of node.value.children) {
          visit(node, child);
        }
      }

      return node;
    }

    const transactionQueue = trace.transactions ?? [];
    const orphanErrorsQueue = trace.orphan_errors ?? [];

    let tIdx = 0;
    let oIdx = 0;
    const tLen = transactionQueue.length;
    const oLen = orphanErrorsQueue.length;

    // Items in each queue are sorted by timestamp, so we just take
    // from the queue with the earliest timestamp which means the final list will be ordered.
    while (tIdx < tLen || oIdx < oLen) {
      const transaction = transactionQueue[tIdx];
      const orphan = orphanErrorsQueue[oIdx];

      if (transaction && orphan) {
        if (
          typeof orphan.timestamp === 'number' &&
          transaction.start_timestamp <= orphan.timestamp
        ) {
          visit(traceNode, transaction);
          tIdx++;
        } else {
          visit(traceNode, orphan);
          oIdx++;
        }
      } else if (transaction) {
        visit(traceNode, transaction);
        tIdx++;
      } else if (orphan) {
        visit(traceNode, orphan);
        oIdx++;
      }
    }

    tree.indicators.sort((a, b) => a.start - b.start);

    for (const indicator of tree.indicators) {
      if (indicator.start > traceEnd) {
        traceEnd = indicator.start;
      }

      indicator.start *= traceNode.multiplier;
    }

    // The sum of all durations of traces that exist under a replay is not always
    // equal to the duration of the replay. We need to adjust the traceview bounds
    // to ensure that we can see the max of the replay duration and the sum(trace durations). This way, we
    // can ensure that the replay timestamp indicators are always visible in the traceview along with all spans from the traces.
    if (replayRecord) {
      const replayStart = replayRecord.started_at.getTime() / 1000;
      const replayEnd = replayRecord.finished_at.getTime() / 1000;

      traceStart = Math.min(traceStart, replayStart);
      traceEnd = Math.max(traceEnd, replayEnd);
    }

    traceNode.space = [
      traceStart * traceNode.multiplier,
      (traceEnd - traceStart) * traceNode.multiplier,
    ];

    tree.root.space = [
      traceStart * traceNode.multiplier,
      (traceEnd - traceStart) * traceNode.multiplier,
    ];

    return tree.build();
  }

  static FromSpans(
    parent: TraceTreeNode<TraceTree.NodeValue>,
    data: Event,
    spans: TraceTree.RawSpan[],
    options: {sdk: string | undefined} | undefined
  ): [TraceTreeNode<TraceTree.NodeValue>, [number, number] | null] {
    TraceTree.invalidate(parent, true);
    const platformHasMissingSpans = shouldAddMissingInstrumentationSpan(options?.sdk);

    const min_span_start = Number.POSITIVE_INFINITY;
    const min_span_end = Number.NEGATIVE_INFINITY;

    const parentIsSpan = isSpanNode(parent);
    const lookuptable: Record<
      TraceTree.RawSpan['span_id'],
      TraceTreeNode<TraceTree.Span | TraceTree.Transaction>
    > = {};

    // If we've already fetched children, the tree is already assembled
    if (parent.spanChildren.length > 0) {
      parent.zoomedIn = true;
      return [parent, null];
    }

    if (parentIsSpan) {
      if (parent.value && 'span_id' in parent.value) {
        lookuptable[parent.value.span_id] = parent as TraceTreeNode<TraceTree.Span>;
      }
    }

    const transactionsToSpanMap = new Map<
      string,
      TraceTreeNode<TraceTree.Transaction>[]
    >();

    let firstTransaction: TraceTreeNode<TraceTree.Transaction> | null = null;
    for (const child of parent.children) {
      if (isTransactionNode(child)) {
        firstTransaction = firstTransaction ?? child;
        // keep track of the transaction nodes that should be reparented under the newly fetched spans.
        const key =
          'parent_span_id' in child.value &&
          typeof child.value.parent_span_id === 'string'
            ? child.value.parent_span_id
            : // This should be unique, but unreachable at lookup time.
              `unreachable-${child.value.event_id}`;

        const list = transactionsToSpanMap.get(key) ?? [];
        list.push(child);
        transactionsToSpanMap.set(key, list);
      }
    }

    const remappedTransactionParents = new Set<TraceTreeNode<TraceTree.NodeValue>>();

    for (const [node, _] of tree.vitals) {
      if (
        baseTraceNode.space?.[0] &&
        node.value &&
        'start_timestamp' in node.value &&
        'measurements' in node.value
      ) {
        this.collectMeasurements(
          node,
          baseTraceNode.space[0],
          node.value.measurements as Record<string, Measurement>,
          this.vitals,
          this.vital_types,
          this.indicators
        );
      }
    }

    // We need to invalidate the data in the last node of the tree
    // so that the connectors are updated and pointing to the sibling nodes
    const last = this.root.children[this.root.children.length - 1];
    last.invalidate(last);

    for (const child of tree.root.children) {
      this._list = this._list.concat(child.getVisibleChildren());
    }
  }

  findByEventId(
    start: TraceTreeNode<TraceTree.NodeValue>,
    eventId: string
  ): TraceTreeNode<TraceTree.NodeValue> | null {
    return TraceTreeNode.Find(start, node => {
      if (isTransactionNode(node)) {
        return node.value.event_id === eventId;
      }
      if (isSpanNode(node)) {
        return node.value.span_id === eventId;
      }
      if (isTraceErrorNode(node)) {
        return node.value.event_id === eventId;
      }
      return hasEventWithEventId(node, eventId);
    });
  }

  findByPath(
    start: TraceTreeNode<TraceTree.NodeValue>,
    path: TraceTree.NodePath[]
  ): TraceTreeNode<TraceTree.NodeValue> | null {
    const queue = [...path];
    let segment = start;
    let node: TraceTreeNode<TraceTree.NodeValue> | null = null;

    while (queue.length > 0) {
      const current = queue.pop()!;

      node = findInTreeFromSegment(segment, current);
      if (!node) {
        return null;
      }
      segment = node;
    }

    return node;
  }

  get shape(): TraceType {
    const trace = this.root.children[0];
    if (!trace) {
      return TraceType.EMPTY_TRACE;
    }

    if (!isTraceNode(trace)) {
      throw new TypeError('Not trace node');
    }

    const {transactions, orphan_errors} = trace.value;
    const traceStats = transactions?.reduce<{
      javascriptRootTransactions: TraceTree.Transaction[];
      orphans: number;
      roots: number;
    }>(
      (stats, transaction) => {
        if (isRootTransaction(transaction)) {
          stats.roots++;

          if (isJavascriptSDKTransaction(transaction)) {
            stats.javascriptRootTransactions.push(transaction);
          }
        } else {
          stats.orphans++;
        }
        return stats;
      },
      {roots: 0, orphans: 0, javascriptRootTransactions: []}
    ) ?? {roots: 0, orphans: 0, javascriptRootTransactions: []};

    if (traceStats.roots === 0) {
      if (traceStats.orphans > 0) {
        return TraceType.NO_ROOT;
      }

      if (orphan_errors && orphan_errors.length > 0) {
        return TraceType.ONLY_ERRORS;
      }

      return TraceType.EMPTY_TRACE;
    }

    if (traceStats.roots === 1) {
      if (traceStats.orphans > 0) {
        return TraceType.BROKEN_SUBTRACES;
      }

      return TraceType.ONE_ROOT;
    }

    if (traceStats.roots > 1) {
      if (traceStats.javascriptRootTransactions.length > 0) {
        return TraceType.BROWSER_MULTIPLE_ROOTS;
      }

      return TraceType.MULTIPLE_ROOTS;
    }

    throw new Error('Unknown trace type');
  }

  static FromSpans(
    parent: TraceTreeNode<TraceTree.NodeValue>,
    data: Event,
    spans: TraceTree.RawSpan[],
    options: {sdk: string | undefined} | undefined
  ): [TraceTreeNode<TraceTree.NodeValue>, [number, number] | null] {
    parent.invalidate(parent);
    const platformHasMissingSpans = shouldAddMissingInstrumentationSpan(options?.sdk);

    let min_span_start = Number.POSITIVE_INFINITY;
    let min_span_end = Number.NEGATIVE_INFINITY;

    const parentIsSpan = isSpanNode(parent);
    const lookuptable: Record<
      TraceTree.RawSpan['span_id'],
      TraceTreeNode<TraceTree.Span | TraceTree.Transaction>
    > = {};

    // If we've already fetched children, the tree is already assembled
    if (parent.spanChildren.length > 0) {
      parent.zoomedIn = true;
      return [parent, null];
    }

    if (parentIsSpan) {
      if (parent.value && 'span_id' in parent.value) {
        lookuptable[parent.value.span_id] = parent as TraceTreeNode<TraceTree.Span>;
      }
    }

    const transactionsToSpanMap = new Map<
      string,
      TraceTreeNode<TraceTree.Transaction>[]
    >();

    let firstTransaction: TraceTreeNode<TraceTree.Transaction> | null = null;
    for (const child of parent.children) {
      if (isTransactionNode(child)) {
        firstTransaction = firstTransaction ?? child;
        // keep track of the transaction nodes that should be reparented under the newly fetched spans.
        const key =
          'parent_span_id' in child.value &&
          typeof child.value.parent_span_id === 'string'
            ? child.value.parent_span_id
            : // This should be unique, but unreachable at lookup time.
              `unreachable-${child.value.event_id}`;

        const list = transactionsToSpanMap.get(key) ?? [];
        list.push(child);
        transactionsToSpanMap.set(key, list);
      }
    }

    const remappedTransactionParents = new Set<TraceTreeNode<TraceTree.NodeValue>>();

    for (const span of spans) {
      let childTransactions = transactionsToSpanMap.get(span.span_id) ?? [];

      const spanNodeValue: TraceTree.Span = {
        ...span,
        event: data as EventTransaction,
        childTransactions,
      };

      // If we have a browser request span and a server request handler transaction, we want to
      // reparent the transaction under the span. This is because the server request handler
      // was the parent of the browser request span which likely served the document.
      if (
        firstTransaction &&
        firstTransaction.reparent_reason === 'pageload server handler' &&
        !childTransactions.length &&
        isBrowserRequestSpan(spanNodeValue) &&
        isServerRequestHandlerTransactionNode(firstTransaction)
      ) {
        childTransactions = [firstTransaction];
        spanNodeValue.childTransactions = childTransactions;
        transactionsToSpanMap.delete(`unreachable-${firstTransaction.value.event_id}`);
      }

      const node: TraceTreeNode<TraceTree.Span> = new TraceTreeNode(null, spanNodeValue, {
        event_id: parent.metadata.event_id,
        project_slug: parent.metadata.project_slug,
      });

      if (
        typeof span.start_timestamp === 'number' &&
        span.start_timestamp < min_span_start
      ) {
        min_span_start = span.start_timestamp;
      }
      if (typeof span.timestamp === 'number' && span.timestamp > min_span_end) {
        min_span_end = span.timestamp;
      }

      for (const error of getRelatedSpanErrorsFromTransaction(span, parent)) {
        node.errors.add(error);
      }

      for (const performanceIssue of getRelatedPerformanceIssuesFromTransaction(
        span,
        parent
      )) {
        node.performance_issues.add(performanceIssue);
      }

      // This is the case where the current span is the parent of a transaction.
      // When zooming into the parent of the txn, we want to place a copy
      // of the txn as a child of the parenting span.
      if (childTransactions) {
        for (const childTransaction of childTransactions) {
          const clonedChildTxn = cloneTraceTreeNode(childTransaction);
          node.spanChildren.push(clonedChildTxn);
          clonedChildTxn.parent = node;
          remappedTransactionParents.add(node);
          // Delete the transaction from the lookup table so that we don't
          // duplicate the transaction in the tree.
        }
        transactionsToSpanMap.delete(span.span_id);
      }

      lookuptable[span.span_id] = node;

      if (span.parent_span_id) {
        const spanParentNode = lookuptable[span.parent_span_id];

        if (spanParentNode) {
          node.parent = spanParentNode;
          const previous =
            spanParentNode.spanChildren[spanParentNode.spanChildren.length - 1];
          if (
            platformHasMissingSpans &&
            previous &&
            shouldInsertMissingInstrumentationSpan(previous, node)
          ) {
            insertMissingInstrumentationSpan(
              spanParentNode,
              spanParentNode.spanChildren[spanParentNode.spanChildren.length - 1]!,
              node
            );
          }
          spanParentNode.spanChildren.push(node);
          continue;
        }
      }

      const previous = parent.spanChildren[parent.spanChildren.length - 1];
      if (
        platformHasMissingSpans &&
        previous &&
        shouldInsertMissingInstrumentationSpan(previous, node)
      ) {
        insertMissingInstrumentationSpan(
          parent,
          parent.spanChildren[parent.spanChildren.length - 1],
          node
        );
      }

      parent.spanChildren.push(node);
      node.parent = parent;
    }

    // Whatever remains is transaction nodes that we failed to reparent under the spans.
    for (const [_, transactions] of transactionsToSpanMap) {
      for (const transaction of transactions) {
        if ('parent_span_id' in transaction.value && !!transaction.value.parent_span_id) {
          Sentry.withScope(scope => {
            scope.setFingerprint(['trace-view-reparenting']);
            scope.captureMessage(
              'Failed to reparent transaction under span. None of the spans we fetched had a span_id matching the parent_span_id of the transaction.'
            );
          });
        }
        const cloned = cloneTraceTreeNode(transaction);
        parent.spanChildren.push(cloned);
        cloned.parent = parent;
      }
    }

    for (const c of remappedTransactionParents) {
      c.spanChildren.sort(chronologicalSort);
    }

    parent.zoomedIn = true;

    TraceTree.AutogroupSiblingSpanNodes(parent);
    TraceTree.AutogroupDirectChildrenSpanNodes(parent);

    return [parent, [min_span_start, min_span_end]];
  }

  fetchAdditionalTraces(options: {
    api: Client;
    filters: any;
    metaResults: TraceMetaQueryResults | null;
    organization: Organization;
    replayTraces: ReplayTrace[];
    rerender: () => void;
    urlParams: Location['query'];
  }): () => void {
    let cancelled = false;
    const {organization, api, urlParams, filters, rerender, replayTraces} = options;
    const clonedTraceIds = [...replayTraces];

    const root = this.root.children[0];
    root.fetchStatus = 'loading';
    rerender();

    (async () => {
      while (clonedTraceIds.length > 0) {
        const batch = clonedTraceIds.splice(0, 3);
        const results = await Promise.allSettled(
          batch.map(batchTraceData => {
            return fetchTrace(api, {
              orgSlug: organization.slug,
              query: qs.stringify(
                getTraceQueryParams(urlParams, filters.selection, {
                  timestamp: batchTraceData.timestamp,
                })
              ),
              traceId: batchTraceData.traceSlug,
            });
          })
        );

        if (cancelled) {
          return;
        }

        const updatedData = results.reduce(
          (acc, result) => {
            // Ignoring the error case for now
            if (result.status === 'fulfilled') {
              const {transactions, orphan_errors} = result.value;
              acc.transactions.push(...transactions);
              acc.orphan_errors.push(...orphan_errors);
            }

            return acc;
          },
          {
            transactions: [],
            orphan_errors: [],
          } as TraceSplitResults<TraceTree.Transaction>
        );

        this.appendTree(TraceTree.FromTrace(updatedData, options.metaResults, null));
        rerender();
      }

      root.fetchStatus = 'idle';
      rerender();
    })();

    return () => {
      root.fetchStatus = 'idle';
      cancelled = true;
    };
  }

  appendTree(tree: TraceTree) {
    const baseTraceNode = this.root.children[0];
    const additionalTraceNode = tree.root.children[0];

    if (!baseTraceNode || !additionalTraceNode) {
      throw new Error('No trace node found in tree');
    }

    for (const child of additionalTraceNode.children) {
      child.parent = baseTraceNode;
      baseTraceNode.children.push(child);
    }

    for (const error of additionalTraceNode.errors) {
      baseTraceNode.errors.add(error);
    }

    for (const performanceIssue of additionalTraceNode.performance_issues) {
      baseTraceNode.performance_issues.add(performanceIssue);
    }

    for (const profile of additionalTraceNode.profiles) {
      baseTraceNode.profiles.push(profile);
    }

    for (const [node, vitals] of tree.vitals) {
      this.vitals.set(node, vitals);
    }

    for (const [node, _] of tree.vitals) {
      if (
        baseTraceNode.space?.[0] &&
        node.value &&
        'start_timestamp' in node.value &&
        'measurements' in node.value
      ) {
        collectMeasurements(
          node,
          baseTraceNode.space[0],
          node.value.measurements as Record<string, Measurement>,
          this.vitals,
          this.vital_types,
          this.indicators
        );
      }
    }

    // We need to invalidate the data in the last node of the tree
    // so that the connectors are updated and pointing to the sibling nodes
    const last = this.root.children[this.root.children.length - 1];
    TraceTree.invalidate(last, true);

    for (const child of tree.root.children) {
      this.list = this.list.concat(TraceTree.VisibleChildren(child));
    }
  }

  /**
   * Invalidate the visual data used to render the tree, forcing it
   * to be recalculated on the next render. This is useful when for example
   * the tree is expanded or collapsed, or when the tree is mutated and
   * the visual data is no longer valid as the indentation changes
   */
  static invalidate(node: TraceTreeNode<TraceTree.NodeValue>, recurse: boolean) {
    node.invalidate();

    if (recurse) {
      const queue = [...node.children];

      if (isParentAutogroupedNode(node)) {
        queue.push(node.head);
      }

      while (queue.length > 0) {
        const next = queue.pop()!;
        TraceTree.invalidate(next, false);

        if (isParentAutogroupedNode(next)) {
          queue.push(next.head);
        }

        for (let i = 0; i < next.children.length; i++) {
          queue.push(next.children[i]);
        }
      }
    }
  }

  static AutogroupDirectChildrenSpanNodes(
    root: TraceTreeNode<TraceTree.NodeValue>
  ): void {
    const queue = [root];

    while (queue.length > 0) {
      const node = queue.pop()!;

      if (node.children.length > 1 || !isSpanNode(node)) {
        for (const child of node.children) {
          queue.push(child);
        }
        continue;
      }

      const head = node;
      let tail = node;
      let groupMatchCount = 0;

      const errors: TraceErrorType[] = [];
      const performance_issues: TraceTree.TracePerformanceIssue[] = [];

      let start = head.value.start_timestamp;
      let end = head.value.timestamp;

      while (
        tail &&
        tail.children.length === 1 &&
        isSpanNode(tail.children[0]) &&
        tail.children[0].value.op === head.value.op
      ) {
        if ((tail?.errors?.size ?? 0) > 0) {
          errors.push(...tail?.errors);
        }
        if ((tail?.performance_issues?.size ?? 0) > 0) {
          performance_issues.push(...tail.performance_issues);
        }

        // Collect start/end of all nodes in the list
        // so that we can properly render a autogrouped bar that
        // encapsulates all the nodes in the list
        if (tail.value.start_timestamp < start) {
          start = tail.value.start_timestamp;
        }
        if (tail.value.timestamp > end) {
          end = tail.value.timestamp;
        }
        groupMatchCount++;
        tail = tail.children[0];
      }

      // Checking the tail node for errors as it is not included in the grouping
      // while loop, but is hidden when the autogrouped node is collapsed
      if ((tail?.errors?.size ?? 0) > 0) {
        errors.push(...tail?.errors);
      }
      if ((tail?.performance_issues?.size ?? 0) > 0) {
        performance_issues.push(...tail.performance_issues);
      }

      if (groupMatchCount < 1) {
        for (const child of head.children) {
          queue.push(child);
        }
        continue;
      }

      const autoGroupedNode = new ParentAutogroupNode(
        node.parent,
        {
          ...head.value,
          start_timestamp: start,
          timestamp: end,
          autogrouped_by: {
            op: head.value && 'op' in head.value ? head.value.op ?? '' : '',
          },
        },
        {
          event_id: undefined,
          project_slug: undefined,
        },
        head,
        tail
      );

      if (!node.parent) {
        throw new Error('Parent node is missing, this should be unreachable code');
      }

      const index = node.parent.children.indexOf(node);
      node.parent.children[index] = autoGroupedNode;

      autoGroupedNode.head.parent = autoGroupedNode;
      autoGroupedNode.groupCount = groupMatchCount + 1;
      autoGroupedNode.space = [
        start * autoGroupedNode.multiplier,
        (end - start) * autoGroupedNode.multiplier,
      ];

      for (const error of errors) {
        autoGroupedNode.errors.add(error);
      }

      for (const performanceIssue of performance_issues) {
        autoGroupedNode.performance_issues.add(performanceIssue);
      }

      for (const c of tail.children) {
        c.parent = autoGroupedNode;
        queue.push(c);
      }
    }
  }

  static AutogroupSiblingSpanNodes(root: TraceTreeNode<TraceTree.NodeValue>): void {
    const queue = [root];

    while (queue.length > 0) {
      const node = queue.pop()!;

      for (const child of node.children) {
        queue.push(child);
      }

      if (isAutogroupedNode(node)) {
        continue;
      }

      if (node.children.length < 5) {
        continue;
      }

      let index = 0;
      let matchCount = 0;

      while (index < node.children.length) {
        if (!isSpanNode(node.children[index])) {
          index++;
          matchCount = 0;
          continue;
        }
        const current = node.children[index] as TraceTreeNode<TraceTree.Span>;
        const next = node.children[index + 1] as TraceTreeNode<TraceTree.Span>;

        if (
          next &&
          isSpanNode(next) &&
          next.children.length === 0 &&
          current.children.length === 0 &&
          next.value.op === current.value.op &&
          next.value.description === current.value.description
        ) {
          matchCount++;
          // If the next node is the last node in the list, we keep iterating
          if (index + 1 < node.children.length) {
            index++;
            continue;
          }
        }

        if (matchCount >= 4) {
          const autoGroupedNode = new SiblingAutogroupNode(
            node,
            {
              ...current.value,
              autogrouped_by: {
                op: current.value.op ?? '',
                description: current.value.description ?? '',
              },
            },
            {
              event_id: undefined,
              project_slug: undefined,
            }
          );

          autoGroupedNode.groupCount = matchCount + 1;
          const start = index - matchCount;
          let start_timestamp = Number.MAX_SAFE_INTEGER;
          let timestamp = Number.MIN_SAFE_INTEGER;

          for (let j = start; j < start + matchCount + 1; j++) {
            const child = node.children[j];
            if (
              child.value &&
              'timestamp' in child.value &&
              typeof child.value.timestamp === 'number' &&
              child.value.timestamp > timestamp
            ) {
              timestamp = child.value.timestamp;
            }

            if (
              child.value &&
              'start_timestamp' in child.value &&
              typeof child.value.start_timestamp === 'number' &&
              child.value.start_timestamp < start_timestamp
            ) {
              start_timestamp = child.value.start_timestamp;
            }

            if (child.hasErrors) {
              for (const error of child.errors) {
                autoGroupedNode.errors.add(error);
              }

              for (const performanceIssue of child.performance_issues) {
                autoGroupedNode.performance_issues.add(performanceIssue);
              }
            }

            autoGroupedNode.children.push(node.children[j]);
            autoGroupedNode.children[autoGroupedNode.children.length - 1].parent =
              autoGroupedNode;
          }

          autoGroupedNode.space = [
            start_timestamp * autoGroupedNode.multiplier,
            (timestamp - start_timestamp) * autoGroupedNode.multiplier,
          ];

          node.children.splice(start, matchCount + 1, autoGroupedNode);
          index = start + 1;
          matchCount = 0;
        } else {
          index++;
          matchCount = 0;
        }
      }
    }
  }

  static VisibleChildren(
    root: TraceTreeNode<TraceTree.NodeValue>
  ): TraceTreeNode<TraceTree.NodeValue>[] {
    const stack: TraceTreeNode<TraceTree.NodeValue>[] = [];
    const children: TraceTreeNode<TraceTree.NodeValue>[] = [];

    if (
      root.expanded ||
      isParentAutogroupedNode(root) ||
      isMissingInstrumentationNode(root)
    ) {
      for (let i = root.children.length - 1; i >= 0; i--) {
        stack.push(root.children[i]);
      }
    }

    while (stack.length > 0) {
      const node = stack.pop()!;
      children.push(node);
      // Since we're using a stack and it's LIFO, reverse the children before pushing them
      // to ensure they are processed in the original left-to-right order.
      if (node.expanded || isParentAutogroupedNode(node)) {
        for (let i = node.children.length - 1; i >= 0; i--) {
          stack.push(node.children[i]);
        }
      }
    }

    return children;
  }

  // Returns the min path required to reach the node from the root.
  // @TODO: skip nodes that do not require fetching
  static PathToNode(node: TraceTreeNode<TraceTree.NodeValue>): TraceTree.NodePath[] {
    const nodes: TraceTreeNode<TraceTree.NodeValue>[] = [node];
    let current: TraceTreeNode<TraceTree.NodeValue> | null = node.parent;

    if (isSpanNode(node) || isAutogroupedNode(node)) {
      while (
        current &&
        (isSpanNode(current) || (isAutogroupedNode(current) && !current.expanded))
      ) {
        current = current.parent;
      }
    }

    while (current) {
      if (isTransactionNode(current)) {
        nodes.push(current);
      }
      if (isSpanNode(current)) {
        nodes.push(current);

        while (current.parent) {
          if (isTransactionNode(current.parent)) {
            break;
          }
          if (isAutogroupedNode(current.parent) && current.parent.expanded) {
            break;
          }
          current = current.parent;
        }
      }
      if (isAutogroupedNode(current)) {
        nodes.push(current);
      }

      current = current.parent;
    }

    return nodes.map(nodeToId);
  }

  // Returns boolean to indicate if node was updated
  expand(node: TraceTreeNode<TraceTree.NodeValue>, expanded: boolean): boolean {
    if (expanded === node.expanded) {
      return false;
    }

    // Expanding is not allowed for zoomed in nodes
    if (node.zoomedIn) {
      return false;
    }

    if (node instanceof ParentAutogroupNode) {
      // In parent autogrouping, we perform a node swap and either point the
      // head or tails of the autogrouped sequence to the autogrouped node
      if (node.expanded) {
        const index = this.list.indexOf(node);

        const autogroupedChildren = TraceTree.VisibleChildren(node);
        this.list.splice(index + 1, autogroupedChildren.length);

        const newChildren = TraceTree.VisibleChildren(node.tail);

        for (const c of node.tail.children) {
          c.parent = node;
        }

        this.list.splice(index + 1, 0, ...newChildren);
      } else {
        node.head.parent = node;
        const index = this.list.indexOf(node);
        const childrenCount = TraceTree.VisibleChildren(node).length;

        this.list.splice(index + 1, childrenCount);

        const newChildren = [node.head].concat(
          TraceTree.VisibleChildren(node.head) as TraceTreeNode<TraceTree.Span>[]
        );

        for (const c of node.children) {
          c.parent = node.tail;
        }

        this.list.splice(index + 1, 0, ...newChildren);
      }

      TraceTree.invalidate(node, true);
      node.expanded = expanded;
      return true;
    }

    if (node.expanded) {
      const index = this.list.indexOf(node);
      this.list.splice(index + 1, TraceTree.VisibleChildren(node).length);
      // Flip expanded after collecting visible children
      node.expanded = expanded;
    } else {
      const index = this.list.indexOf(node);
      // Flip expanded so that we can collect visible children
      node.expanded = expanded;
      this.list.splice(index + 1, 0, ...TraceTree.VisibleChildren(node));
    }
    node.expanded = expanded;
    return true;
  }

  static ExpandToEventID(
    eventId: string,
    tree: TraceTree,
    rerender: () => void,
    options: ViewManagerScrollToOptions
  ): Promise<TraceTreeNode<TraceTree.NodeValue> | null> {
    const node = TraceTree.FindByEventId(tree.root, eventId);

    if (!node) {
      return Promise.resolve(null);
    }

    return TraceTree.ExpandToPath(tree, TraceTree.PathToNode(node), rerender, options);
  }

  static ExpandToPath(
    tree: TraceTree,
    scrollQueue: TraceTree.NodePath[],
    rerender: () => void,
    options: ViewManagerScrollToOptions
  ): Promise<TraceTreeNode<TraceTree.NodeValue> | null> {
    const segments = [...scrollQueue];
    const list = tree.list;

    if (!list) {
      return Promise.resolve(null);
    }

    if (segments.length === 1 && segments[0] === 'trace-root') {
      rerender();
      return Promise.resolve(tree.root.children[0]);
    }

    // Keep parent reference as we traverse the tree so that we can only
    // perform searching in the current level and not the entire tree
    let parent: TraceTreeNode<TraceTree.NodeValue> = tree.root;

    const recurseToRow = async (): Promise<TraceTreeNode<TraceTree.NodeValue> | null> => {
      const path = segments.pop();
      let current = TraceTree.FindInTreeFromSegment(parent, path!);

      if (!current) {
        // Some parts of the codebase link to span:span_id, txn:event_id, where span_id is
        // actally stored on the txn:event_id node. Since we cant tell from the link itself
        // that this is happening, we will perform a final check to see if we've actually already
        // arrived to the node in the previous search call.
        if (path) {
          const [type, id] = path.split('-');

          if (
            type === 'span' &&
            isTransactionNode(parent) &&
            parent.value.span_id === id
          ) {
            current = parent;
          }
        }

        if (!current) {
          Sentry.captureMessage('Failed to scroll to node in trace tree');
          return null;
        }
      }

      // Reassing the parent to the current node so that
      // searching narrows down to the current level
      // and we dont need to search the entire tree each time
      parent = current;

      if (isTransactionNode(current)) {
        const nextSegment = segments[segments.length - 1];
        if (
          nextSegment?.startsWith('span-') ||
          nextSegment?.startsWith('empty-') ||
          nextSegment?.startsWith('ag-') ||
          nextSegment?.startsWith('ms-')
        ) {
          await tree.zoomIn(current, true, options);
          return recurseToRow();
        }
      }

      if (isAutogroupedNode(current) && segments.length > 0) {
        tree.expand(current, true);
        return recurseToRow();
      }

      if (segments.length > 0) {
        return recurseToRow();
      }

      rerender();
      return current;
    };

    return recurseToRow();
  }

  static Filter(
    node: TraceTreeNode<TraceTree.NodeValue>,
    predicate: (node: TraceTreeNode) => boolean
  ): TraceTreeNode<TraceTree.NodeValue> {
    const queue = [node];

    while (queue.length) {
      const next = queue.pop()!;
      for (let i = 0; i < next.children.length; i++) {
        if (!predicate(next.children[i])) {
          next.children.splice(i, 1);
        } else {
          queue.push(next.children[i]);
        }
      }
    }

    return node;
  }

  static Find(
    root: TraceTreeNode<TraceTree.NodeValue>,
    predicate: (node: TraceTreeNode<TraceTree.NodeValue>) => boolean
  ): TraceTreeNode<TraceTree.NodeValue> | null {
    const queue = [root];

    while (queue.length > 0) {
      const next = queue.pop()!;

      if (predicate(next)) {
        return next;
      }

      if (isParentAutogroupedNode(next)) {
        queue.push(next.head);
      } else {
        for (const child of next.children) {
          queue.push(child);
        }
      }
    }

    return null;
  }

  static FindInTreeFromSegment(
    start: TraceTreeNode<TraceTree.NodeValue>,
    segment: TraceTree.NodePath
  ): TraceTreeNode<TraceTree.NodeValue> | null {
    const [type, id] = segment.split('-');

    if (!type || !id) {
      throw new TypeError('Node path must be in the format of `type-id`');
    }

    return TraceTree.Find(start, node => {
      if (type === 'txn' && isTransactionNode(node)) {
        return node.value.event_id === id;
      }
      if (type === 'span' && isSpanNode(node)) {
        return node.value.span_id === id;
      }

      if (type === 'ag' && isAutogroupedNode(node)) {
        if (isParentAutogroupedNode(node)) {
          return node.head.value.span_id === id || node.tail.value.span_id === id;
        }
        if (isSiblingAutogroupedNode(node)) {
          const child = node.children[0];
          if (isSpanNode(child)) {
            return child.value.span_id === id;
          }
        }
      }

      if (type === 'ms' && isMissingInstrumentationNode(node)) {
        return node.previous.value.span_id === id || node.next.value.span_id === id;
      }

      if (type === 'error' && isTraceErrorNode(node)) {
        return node.value.event_id === id;
      }

      return false;
    });
  }

  static FindByPath(
    start: TraceTreeNode<TraceTree.NodeValue>,
    path: TraceTree.NodePath[]
  ): TraceTreeNode<TraceTree.NodeValue> | null {
    const queue = [...path];
    let segment = start;
    let node: TraceTreeNode<TraceTree.NodeValue> | null = null;

    while (queue.length > 0) {
      const current = queue.pop()!;

      node = TraceTree.FindInTreeFromSegment(segment, current);
      if (!node) {
        return null;
      }
      segment = node;
    }

    return node;
  }

  static FindByEventId(
    start: TraceTreeNode<TraceTree.NodeValue>,
    eventId: string
  ): TraceTreeNode<TraceTree.NodeValue> | null {
    return TraceTree.Find(start, node => {
      if (isTransactionNode(node)) {
        return node.value.event_id === eventId;
      }
      if (isSpanNode(node)) {
        return node.value.span_id === eventId;
      }
      if (isTraceErrorNode(node)) {
        return node.value.event_id === eventId;
      }

      if (isTraceNode(node)) {
        return false;
      }

      // If we dont have an exact match, then look for an event_id in the errors or performance issues
      for (const e of node.errors) {
        if (e.event_id === eventId) {
          return true;
        }
      }
      for (const p of node.performance_issues) {
        if (p.event_id === eventId) {
          return true;
        }
      }

      return false;
    });
  }

  static ForEachChild(
    root: TraceTreeNode<TraceTree.NodeValue>,
    cb: (node: TraceTreeNode<TraceTree.NodeValue>) => void
  ): void {
    const queue = [root];

    while (queue.length > 0) {
      const next = queue.pop()!;
      cb(next);

      if (isParentAutogroupedNode(next)) {
        queue.push(next.head);
      } else {
        const children = next.spanChildren ? next.spanChildren : next.children;
        for (const child of children) {
          queue.push(child);
        }
      }
    }
  }

  static ParentTransaction(
    node: TraceTreeNode<TraceTree.NodeValue>
  ): TraceTreeNode<TraceTree.Transaction> | null {
    let next: TraceTreeNode<TraceTree.NodeValue> | null = node;

    while (next) {
      if (isTransactionNode(next)) {
        return next;
      }
      next = next.parent;
    }

    return null;
  }

  zoomIn(
    node: TraceTreeNode<TraceTree.NodeValue>,
    zoomedIn: boolean,
    options: {
      api: Client;
      organization: Organization;
    }
  ): Promise<Event | null> {
    if (zoomedIn === node.zoomedIn) {
      return Promise.resolve(null);
    }

    if (!zoomedIn) {
      const index = this.list.indexOf(node);

      if (index === -1) {
        return Promise.resolve(null);
      }

      this.list.splice(index + 1, TraceTree.VisibleChildren(node).length);

      node.zoomedIn = zoomedIn;
      TraceTree.invalidate(node, true);

      if (node.expanded) {
        this.list.splice(index + 1, 0, ...TraceTree.VisibleChildren(node));
      }

      return Promise.resolve(null);
    }

    const key =
      options.organization.slug +
      ':' +
      node.metadata.project_slug! +
      ':' +
      node.metadata.event_id!;

    const promise =
      this._spanPromises.get(key) ??
      fetchTransactionSpans(
        options.api,
        options.organization,
        node.metadata.project_slug!,
        node.metadata.event_id!
      );

    node.fetchStatus = 'loading';

    promise
      .then(data => {
        // The user may have collapsed the node before the promise resolved. When that
        // happens, dont update the tree with the resolved data. Alternatively, we could implement
        // a cancellable promise and avoid this cumbersome heuristic.
        // Remove existing entries from the list
        let index = this.list.indexOf(node);
        node.fetchStatus = 'resolved';

        // Some nodes may have gotten cloned and their reference lost due to the fact
        // that we are really maintaining a txn tree as well as a span tree. When this
        // happens, we need to find the original reference in the list so that we can
        // expand it at its new position
        if (index === -1) {
          index = this.list.indexOf(node.cloneReference!);
          if (index === -1) {
            return data;
          }
          node = this.list[index];
          node.fetchStatus = 'resolved';
        }

        if (!node.expanded) {
          return data;
        }

        const spans = data.entries.find(s => s.type === 'spans') ?? {data: []};

        if (node.expanded) {
          const childrenCount = TraceTree.VisibleChildren(node).length;
          if (childrenCount > 0) {
            this.list.splice(index + 1, childrenCount);
          }
        }

        // Api response is not sorted
        spans.data.sort((a, b) => a.start_timestamp - b.start_timestamp);

        const [_, view] = TraceTree.FromSpans(node, data, spans.data, {
          sdk: data.sdk?.name,
        });

        // Spans contain millisecond precision, which means that it is possible for the
        // children spans of a transaction to extend beyond the start and end of the transaction
        // through ns precision. To account for this, we need to adjust the space of the transaction node and the space
        // of our trace so that all of the span children are visible and can be rendered inside the view.
        if (
          view &&
          Number.isFinite(view[0]) &&
          Number.isFinite(view[1]) &&
          this.root.space
        ) {
          const prev_start = this.root.space[0];
          const prev_end = this.root.space[1];
          const new_start = view[0];
          const new_end = view[1];

          // Update the space of the tree and the trace root node
          const start = Math.min(new_start * node.multiplier, this.root.space[0]);
          this.root.space = [
            start,
            Math.max(new_end * node.multiplier - start, this.root.space[1]),
          ];
          this.root.children[0].space = [...this.root.space];

          if (prev_start !== this.root.space[0] || prev_end !== this.root.space[1]) {
            this.dispatch('trace timeline change', this.root.space);
          }
        }

        const spanChildren = TraceTree.VisibleChildren(node);
        this.list.splice(index + 1, 0, ...spanChildren);
        return data;
      })
      .catch(_e => {
        node.fetchStatus = 'error';
      });

    this._spanPromises.set(key, promise);
    return promise;
  }

  // Only supports parent/child swaps (the only ones we need)
  static Swap({
    parent,
    child,
    reason,
  }: {
    child: TraceTreeNode<TraceTree.NodeValue>;
    parent: TraceTreeNode<TraceTree.NodeValue>;
    reason: TraceTreeNode['reparent_reason'];
  }) {
    const parentOfParent = parent.parent!;

    const parentIndex = parentOfParent.children.indexOf(parent);
    parentOfParent.children[parentIndex] = child;
    child.parent = parentOfParent;

    // We need to remove the portion of the tree that was previously a child, else we will have a circular reference
    parent.parent = child;
    child.children.push(TraceTree.Filter(parent, n => n !== child));

    child.reparent_reason = reason;
    parent.reparent_reason = reason;
  }

  toList(): TraceTreeNode<TraceTree.NodeValue>[] {
    const list: TraceTreeNode<TraceTree.NodeValue>[] = [];

    function visit(node: TraceTreeNode<TraceTree.NodeValue>) {
      list.push(node);

      if (!node.expanded) {
        return;
      }

      for (const child of node.children) {
        visit(child);
      }
    }

    for (const child of this.root.children) {
      visit(child);
    }

    return list;
  }

  build() {
    this.list = this.toList();
    return this;
  }

  get shape(): TraceShape {
    const trace = this.root.children[0];
    if (!trace) {
      return TraceShape.EMPTY_TRACE;
    }

    if (!isTraceNode(trace)) {
      throw new TypeError('Not trace node');
    }

    const traceStats = trace.value.transactions?.reduce<{
      javascriptRootTransactions: TraceTree.Transaction[];
      orphans: number;
      roots: number;
    }>(
      (stats, transaction) => {
        if (isRootTransaction(transaction)) {
          stats.roots++;

          if (isJavascriptSDKTransaction(transaction)) {
            stats.javascriptRootTransactions.push(transaction);
          }
        } else {
          stats.orphans++;
        }
        return stats;
      },
      {roots: 0, orphans: 0, javascriptRootTransactions: []}
    ) ?? {roots: 0, orphans: 0, javascriptRootTransactions: []};

    if (traceStats.roots === 0) {
      if (traceStats.orphans > 0) {
        return TraceShape.NO_ROOT;
      }

      if ((trace.value.orphan_errors?.length ?? 0) > 0) {
        return TraceShape.ONLY_ERRORS;
      }

      return TraceShape.EMPTY_TRACE;
    }

    if (traceStats.roots === 1) {
      if (traceStats.orphans > 0) {
        return TraceShape.BROKEN_SUBTRACES;
      }

      return TraceShape.ONE_ROOT;
    }

    if (traceStats.roots > 1) {
      if (traceStats.javascriptRootTransactions.length > 0) {
        return TraceShape.BROWSER_MULTIPLE_ROOTS;
      }

      return TraceShape.MULTIPLE_ROOTS;
    }

    throw new Error('Unknown trace type');
  }

  /**
   * Prints the tree in a human readable format, useful for debugging and testing
   */
  print() {
    // root nodes are -1 indexed, so we add 1 to the depth so .repeat doesnt throw
    const print = this.list
      .map(t => printTraceTreeNode(t, 0))
      .filter(Boolean)
      .join('\n');

    // eslint-disable-next-line no-console
    console.log(print);
  }
}

function collectMeasurements(
  node: TraceTreeNode<TraceTree.NodeValue>,
  start_timestamp: number,
  measurements: Record<string, Measurement>,
  vitals: Map<TraceTreeNode<TraceTree.NodeValue>, TraceTree.CollectedVital[]>,
  vital_types: Set<'web' | 'mobile'>,
  indicators: TraceTree.Indicator[]
): void {
  for (const measurement of COLLECTABLE_MEASUREMENTS) {
    const value = measurements[measurement];

    if (!value || typeof value.value !== 'number') {
      continue;
    }

    if (!vitals.has(node)) {
      vitals.set(node, []);
    }

    WEB_VITALS_LOOKUP.has(measurement) && vital_types.add('web');
    MOBILE_VITALS_LOOKUP.has(measurement) && vital_types.add('mobile');

    const vital = vitals.get(node)!;
    vital.push({
      key: measurement,
      measurement: value,
    });

    if (!RENDERABLE_MEASUREMENTS[measurement]) {
      continue;
    }

    const timestamp = measurementToTimestamp(
      start_timestamp,
      value.value,
      value.unit ?? 'millisecond'
    );

    indicators.push({
      start: timestamp,
      duration: 0,
      measurement: value,
      poor: MEASUREMENT_THRESHOLDS[measurement]
        ? value.value > MEASUREMENT_THRESHOLDS[measurement]
        : false,
      type: measurement as TraceTree.Indicator['type'],
      label: (MEASUREMENT_ACRONYM_MAPPING[measurement] ?? measurement).toUpperCase(),
    });
  }
}

// Generates a ID of the tree node based on its type
function nodeToId(n: TraceTreeNode<TraceTree.NodeValue>): TraceTree.NodePath {
  if (isAutogroupedNode(n)) {
    if (isParentAutogroupedNode(n)) {
      return `ag-${n.head.value.span_id}`;
    }
    if (isSiblingAutogroupedNode(n)) {
      const child = n.children[0];
      if (isSpanNode(child)) {
        return `ag-${child.value.span_id}`;
      }
    }
  }
  if (isTransactionNode(n)) {
    return `txn-${n.value.event_id}`;
  }
  if (isSpanNode(n)) {
    return `span-${n.value.span_id}`;
  }
  if (isTraceNode(n)) {
    return `trace-root`;
  }

  if (isTraceErrorNode(n)) {
    return `error-${n.value.event_id}`;
  }

  if (isRootNode(n)) {
    throw new Error('A path to root node does not exist as the node is virtual');
  }

  if (isMissingInstrumentationNode(n)) {
    if (n.previous) {
      return `ms-${n.previous.value.span_id}`;
    }
    if (n.next) {
      return `ms-${n.next.value.span_id}`;
    }

    throw new Error('Missing instrumentation node must have a previous or next node');
  }

  throw new Error('Not implemented');
}

export function printTraceTreeNode(
  t: TraceTreeNode<TraceTree.NodeValue>,
  offset: number
): string {
  // +1 because we may be printing from the root which is -1 indexed
  const padding = '  '.repeat(t.depth + offset);

  if (isAutogroupedNode(t)) {
    if (isParentAutogroupedNode(t)) {
      return padding + `parent autogroup (${t.groupCount})`;
    }
    if (isSiblingAutogroupedNode(t)) {
      return padding + `sibling autogroup (${t.groupCount})`;
    }

    return padding + 'autogroup';
  }
  if (isSpanNode(t)) {
    return (
      padding +
      (t.value.op || t.value.span_id || 'unknown span') +
      ' ' +
      t.value.description
    );
  }
  if (isTransactionNode(t)) {
    return padding + (t.value.transaction || 'unknown transaction');
  }
  if (isMissingInstrumentationNode(t)) {
    return padding + 'missing_instrumentation';
  }
  if (isRootNode(t)) {
    return padding + 'Root';
  }
  if (isTraceNode(t)) {
    return padding + 'Trace';
  }

  if (isTraceErrorNode(t)) {
    return padding + (t.value.event_id || t.value.level) || 'unknown trace error';
  }

  return 'unknown node';
}
