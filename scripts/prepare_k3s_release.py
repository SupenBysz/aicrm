#!/usr/bin/env python3
"""Render a digest-pinned staging overlay from a verified GitHub release artifact.

The caller must first verify the fixed workflow/repository, successful run and
requested source SHA through the GitHub API. No registry tags are trusted here.
"""
import argparse
import json
from pathlib import Path
import re

COMPONENTS = ('web', 'auth', 'org', 'membership', 'matrix', 'ai', 'migrate')

def validate_release(directory, source_sha, run_id):
    if not re.fullmatch(r'[0-9a-f]{40}', source_sha):
        raise ValueError('full source SHA required')
    if not re.fullmatch(r'[1-9][0-9]*', str(run_id)):
        raise ValueError('positive GitHub run ID required')
    root = Path(directory)
    if (root / 'source-sha').read_text().strip() != source_sha:
        raise ValueError('source SHA does not match approved release')
    if (root / 'run-id').read_text().strip() != str(run_id):
        raise ValueError('run ID does not match approved release')
    images = {}
    for component in COMPONENTS:
        image = (root / f'{component}.digest').read_text().strip()
        if not re.fullmatch(r'ghcr\.io/supenbysz/kycrm-' + component + r'@sha256:[0-9a-f]{64}', image):
            raise ValueError(f'invalid image identity for {component}')
        images[component] = image
    return images

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--artifact', required=True)
    parser.add_argument('--source-sha', required=True)
    parser.add_argument('--run-id', required=True)
    parser.add_argument('--output', required=True)
    args = parser.parse_args()
    images = validate_release(args.artifact, args.source_sha, args.run_id)
    overlay = {'apiVersion': 'kustomize.config.k8s.io/v1beta1', 'kind': 'Kustomization',
               'namespace': 'kycrm-staging', 'resources': ['../../base'], 'images': [
                   {'name': f'ghcr.io/supenbysz/kycrm-{c}', 'newName': images[c].split('@')[0],
                    'digest': images[c].split('@')[1]} for c in COMPONENTS if c != 'migrate']}
    Path(args.output).write_text(json.dumps(overlay, indent=2) + '\n')

if __name__ == '__main__':
    main()
