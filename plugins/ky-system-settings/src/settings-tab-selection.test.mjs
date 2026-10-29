import assert from 'node:assert/strict';
import test from 'node:test';
import {resolveSettingsTab} from './settings-tab-selection.ts';
test('unauthorized appearance falls back to a visible tab instead of keeping an invalid URL',()=>{
 assert.deepEqual(resolveSettingsTab('appearance',['basic-info','settings']),{key:'basic-info',urlValue:'basic-info'});
 assert.equal(resolveSettingsTab('appearance',[]),null);
 assert.deepEqual(resolveSettingsTab('appearance',['appearance']),{key:'appearance',urlValue:'appearance'});
});
test('legacy settings aliases normalize without a back-navigation loop',()=>{
 for(const name of ['settings','parameters'])assert.deepEqual(resolveSettingsTab(name,['settings']),{key:'settings',urlValue:'parameters'});
 assert.deepEqual(resolveSettingsTab(null,['settings']),{key:'settings',urlValue:'parameters'});
 assert.deepEqual(resolveSettingsTab('unknown',['sms','settings']),{key:'sms',urlValue:'sms'});
});
