const _metrics = {
  searches: { started: 0, completed: 0 },
  extracts: { started: 0, completed: 0 },
  errors: [],
  healthRequests: 0,
  startedAt: Date.now(),
};

export function noteSearchStart() { _metrics.searches.started++; }

export function noteSearchComplete() { _metrics.searches.completed++; }

export function noteExtractStart() { _metrics.extracts.started++; }

export function noteExtractComplete() { _metrics.extracts.completed++; }

export function noteError(source, err) {
  _metrics.errors.push({ source, message: err.message, at: new Date().toISOString() });
  if (_metrics.errors.length > 100) _metrics.errors.shift();
}

export function noteHealthRequest() { _metrics.healthRequests++; }

export function runtimeSnapshot() {
  return {
    uptimeMs: Date.now() - _metrics.startedAt,
    searches: { ..._metrics.searches },
    extracts: { ..._metrics.extracts },
    errors: _metrics.errors.length,
    healthRequests: _metrics.healthRequests,
  };
}
