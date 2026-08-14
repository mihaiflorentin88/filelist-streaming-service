import {describe, expect, it} from 'vitest';
import {discoveryHosts, normalizeServerURL} from './discovery';

describe('server discovery', () => {
  it('normalizes manual addresses and preserves custom ports', () => {
    expect(normalizeServerURL('192.168.1.50:8097/')).toBe('http://192.168.1.50:8097');
    expect(normalizeServerURL('https://media.lan:9443/path/')).toBe('https://media.lan:9443/path');
  });

  it('scans only the usable local subnet and omits the television', () => {
    expect(discoveryHosts('192.168.1.2', '255.255.255.252')).toEqual(['192.168.1.1']);
  });

  it('bounds a large LAN to the television local /24', () => {
    const hosts = discoveryHosts('10.2.3.77', '255.0.0.0');
    expect(hosts).toHaveLength(253);
    expect(hosts).toContain('10.2.3.1');
    expect(hosts).not.toContain('10.2.3.77');
    expect(hosts).not.toContain('10.2.4.1');
  });
});
