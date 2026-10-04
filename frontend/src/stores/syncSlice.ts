/**
 * 协作对账 slice（Redux Toolkit）
 * 维护未决冲突列表与已合入协作包登记；冲突的解析（本机 / 协作包二选一）在此落库。
 */
import { createAsyncThunk, createSlice } from '@reduxjs/toolkit';
import { db, listAppliedPackages, listSyncConflicts } from '@/utils/db';
import { resolveConflict, type ConflictResolution } from '@/utils/sync';
import type { AppliedPackage, SyncConflict } from '@/types/sync';
import type { RootState } from './store';

export interface SyncState {
  conflicts: SyncConflict[];
  applied: AppliedPackage[];
  loading: boolean;
  ready: boolean;
  error: string;
}

const initialState: SyncState = {
  conflicts: [],
  applied: [],
  loading: false,
  ready: false,
  error: '',
};

export const loadSyncState = createAsyncThunk('sync/load', async () => {
  const [conflicts, applied] = await Promise.all([listSyncConflicts(), listAppliedPackages()]);
  return { conflicts, applied };
});

export const resolveSyncConflict = createAsyncThunk(
  'sync/resolve',
  async (payload: { conflictId: string; resolution: ConflictResolution }, { dispatch }) => {
    await resolveConflict(payload.conflictId, payload.resolution);
    await dispatch(loadSyncState());
  },
);

/** 直接放弃（删除）一条无法调和的冲突登记，不改动业务记录 */
export const discardSyncConflict = createAsyncThunk('sync/discard', async (conflictId: string, { dispatch }) => {
  await db.syncConflicts.delete(conflictId);
  await dispatch(loadSyncState());
});

const syncSlice = createSlice({
  name: 'sync',
  initialState,
  reducers: {},
  extraReducers: (builder) => {
    builder
      .addCase(loadSyncState.pending, (state) => {
        state.loading = true;
      })
      .addCase(loadSyncState.fulfilled, (state, action) => {
        state.conflicts = action.payload.conflicts;
        state.applied = action.payload.applied;
        state.loading = false;
        state.ready = true;
        state.error = '';
      })
      .addCase(loadSyncState.rejected, (state, action) => {
        state.loading = false;
        state.ready = true;
        state.error = action.error.message ?? '协作冲突读取失败';
      });
  },
});

export const selectSyncConflicts = (state: RootState): SyncConflict[] => state.sync.conflicts;
export const selectAppliedPackages = (state: RootState): AppliedPackage[] => state.sync.applied;

export default syncSlice.reducer;
