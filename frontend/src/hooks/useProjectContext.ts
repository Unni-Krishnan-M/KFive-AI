import { useEffect, useMemo, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { projectApi } from '@/services/api';
import {
  CanonicalProjectContext,
  normalizeCanonicalProject,
  readProjectContext,
} from '@/services/projectContext';
import { readableApiError } from '@/services/runtimeSettings';

interface ProjectContextState {
  projectId?: string;
  context?: CanonicalProjectContext;
  error?: string;
  loading: boolean;
}

export function useProjectContext() {
  const location = useLocation();
  const requested = useMemo(
    () => readProjectContext(location.state, location.search),
    [location.search, location.state],
  );
  const [state, setState] = useState<ProjectContextState>({ loading: Boolean(requested) });
  const requestedProjectId = requested?.projectId;

  useEffect(() => {
    if (!requestedProjectId) {
      setState({ loading: false });
      return;
    }
    let active = true;
    setState({ projectId: requestedProjectId, loading: true });
    projectApi.get(requestedProjectId).then((response) => {
      if (!active) return;
      const context = normalizeCanonicalProject(response.data, requestedProjectId);
      if (!context) throw new Error('The project service returned an invalid project record.');
      setState({ projectId: requestedProjectId, context, loading: false });
    }).catch((error) => {
      if (!active) return;
      setState({
        projectId: requestedProjectId,
        loading: false,
        error: readableApiError(error, 'Project context could not be verified.'),
      });
    });
    return () => { active = false; };
  }, [requestedProjectId]);

  const matchesRequest = state.projectId === requestedProjectId;
  return {
    requested: Boolean(requestedProjectId),
    context: matchesRequest ? state.context : undefined,
    loading: Boolean(requestedProjectId) && (!matchesRequest || state.loading),
    error: matchesRequest ? state.error : undefined,
  };
}
