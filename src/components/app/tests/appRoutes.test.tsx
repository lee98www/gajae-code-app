import assert from 'node:assert/strict';
import test from 'node:test';

import { isValidElement } from 'react';
import { Navigate, matchRoutes, type RouteObject } from 'react-router-dom';

import {
  appShellRoutePaths,
  herdrRoutePaths,
  rootFallbackRoutePath,
} from '../appRoutes';

const appRoutes: RouteObject[] = [
  ...appShellRoutePaths.map((path) => ({ path, element: <output>root shell</output> })),
  ...herdrRoutePaths.map((path) => ({ path, element: <output>herdr</output> })),
  { path: rootFallbackRoutePath, element: <Navigate to="/" replace /> },
];

test('Given the current application routes when matching the root then the root shell route is selected', () => {
  const matches = matchRoutes(appRoutes, '/');

  assert.equal(matches?.at(-1)?.route.path, '/');
});

test('Given Herdr routes when matching paths then the SDK shell route is not selected', () => {
  for (const pathname of ['/herdr', '/herdr/default', '/herdr/default/panes/w1%3Ap1']) {
    const matches = matchRoutes(appRoutes, pathname);
    const element = matches?.at(-1)?.route.element;

    assert.ok(isValidElement(element), pathname);
    assert.equal((element.props as { children?: unknown }).children, 'herdr');
  }
});

test('Herdr deep links preserve decoded parameters under a deployment basename', () => {
  const match = matchRoutes(appRoutes, '/studio/herdr/team-a/panes/w1%3Ap1', '/studio')?.at(-1);
  assert.equal(match?.route.path, '/herdr/:sessionName/panes/:paneId');
  assert.deepEqual(match?.params, { sessionName: 'team-a', paneId: 'w1:p1' });
});

test('Given stale Jobs or unknown paths when matching routes then the root replace redirect is selected', () => {
  for (const pathname of ['/jobs/new', '/jobs/job-123', '/unknown-path']) {
    const matches = matchRoutes(appRoutes, pathname);
    const route = matches?.at(-1)?.route;

    assert.equal(route?.path, '*', pathname);
    assert.ok(isValidElement(route?.element), pathname);
    assert.equal(route.element.type, Navigate, pathname);
    // React 19 types ReactElement.props as unknown; the assertion narrows it.
    const elementProps = route.element.props as { to?: unknown; replace?: unknown };
    assert.equal(elementProps.to, '/', pathname);
    assert.equal(elementProps.replace, true, pathname);
  }
});
