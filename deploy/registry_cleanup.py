#!/usr/bin/env python3
"""Bounded best-effort GC for ONE hardcoded public GHCR package, never arbitrary prune."""
import datetime as dt
import hashlib
import json
import os
import re
import time
import urllib.error
import urllib.parse
import urllib.request

REPOSITORY = 'spread-one/my-mastra'
SOURCE = 'https://github.com/' + REPOSITORY
API = 'https://api.github.com/users/spread-one/packages/container/my-mastra'
MAIN_API = 'https://api.github.com/repos/' + REPOSITORY + '/git/ref/heads/main'
REGISTRY = 'https://ghcr.io/v2/' + REPOSITORY
DIGEST = re.compile(r'sha256:[0-9a-f]{64}')
SHA = re.compile(r'[0-9a-f]{40}')
INDEX = {'application/vnd.oci.image.index.v1+json', 'application/vnd.docker.distribution.manifest.list.v2+json'}
MANIFEST = {'application/vnd.oci.image.manifest.v1+json', 'application/vnd.docker.distribution.manifest.v2+json'}
CONFIG = {'application/vnd.oci.image.config.v1+json', 'application/vnd.docker.container.image.v1+json'}
MAX_DELETIONS = 20
GRACE_SECONDS = 24 * 3600


class Deferred(Exception):
    pass


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, _fp, _code, _msg, _headers, newurl):
        parsed = urllib.parse.urlsplit(newurl)
        # GHCR blob CDN only; NEVER forward GitHub/Bearer credentials to signed URLs.
        if (not req.full_url.startswith(REGISTRY + '/blobs/') or parsed.scheme != 'https'
                or parsed.hostname != 'pkg-containers.githubusercontent.com'
                or parsed.username or parsed.password or parsed.port not in (None, 443)):
            raise Deferred('redirect_rejected')
        return urllib.request.Request(newurl, headers={'User-Agent': 'samkim-app-retention'})


def timestamp(value):
    try:
        parsed = dt.datetime.fromisoformat(value.replace('Z', '+00:00'))
        if parsed.tzinfo is None:
            raise ValueError()
        return parsed.timestamp()
    except (ValueError, TypeError, AttributeError, OverflowError):
        raise Deferred('inventory_invalid') from None


def inventory(rows):
    result = {}
    ids = set()
    for row in rows:
        try:
            digest, version_id = row['name'], row['id']
            tags = row['metadata']['container']['tags']
            if (not DIGEST.fullmatch(digest) or type(version_id) is not int or version_id <= 0
                    or version_id in ids or digest in result or not isinstance(tags, list)
                    or any(not isinstance(tag, str) or len(tag) > 255 for tag in tags)):
                raise Deferred('inventory_invalid')
            result[digest] = {'id': version_id, 'tags': sorted(tags), 'updated': timestamp(row['updated_at']),
                              'created': timestamp(row['created_at'])}
            ids.add(version_id)
        except (KeyError, TypeError):
            raise Deferred('inventory_invalid') from None
    return result


def fingerprint(versions):
    return json.dumps(versions, sort_keys=True)


class Registry:
    def __init__(self, token):
        self.token = token
        self.anonymous = None
        self.deadline = time.monotonic() + 240
        self.opener = urllib.request.build_opener(NoRedirect())

    def request(self, url, method='GET'):
        remaining = self.deadline - time.monotonic()
        if remaining <= 0:
            raise Deferred('time_budget')
        headers = {'User-Agent': 'samkim-app-retention', 'Accept': 'application/vnd.github+json',
                   'X-GitHub-Api-Version': '2022-11-28'}
        if url == API or url.startswith(API + '/versions') or url == MAIN_API:
            headers['Authorization'] = 'Bearer ' + self.token
        elif url.startswith(REGISTRY + '/manifests/') or url.startswith(REGISTRY + '/blobs/'):
            if not self.anonymous:
                raise Deferred('registry_auth_missing')
            headers['Authorization'] = 'Bearer ' + self.anonymous
            headers['Accept'] = ', '.join(sorted(INDEX | MANIFEST))
        elif url != 'https://ghcr.io/token?service=ghcr.io&scope=repository%3Aspread-one%2Fmy-mastra%3Apull':
            raise Deferred('endpoint_rejected')
        try:
            # No retries: errors stop deletion. Logs never contain HTTP bodies or tokens.
            with self.opener.open(urllib.request.Request(url, method=method, headers=headers), timeout=min(10, remaining)) as response:
                if method == 'DELETE' and response.status != 204:
                    raise Deferred('delete_response_unexpected')
                body = response.read(4 * 1024 * 1024 + 1)
                if len(body) > 4 * 1024 * 1024:
                    raise Deferred('response_too_large')
                return body
        except urllib.error.HTTPError as error:
            if error.code in (401, 403):
                raise Deferred('package_actions_access_required' if url.startswith(API) else 'registry_access_denied') from None
            if method == 'DELETE':
                raise Deferred('delete_rejected_public_limit_or_api') from None
            raise Deferred('registry_or_api_read_failed') from None
        except (OSError, urllib.error.URLError, TimeoutError):
            raise Deferred('network_failed') from None

    def json(self, url):
        try:
            return json.loads(self.request(url))
        except (ValueError, UnicodeError):
            raise Deferred('parse_failed') from None

    def authorize(self):
        package = self.json(API)
        if (package.get('name') != 'my-mastra' or package.get('package_type') != 'container'
                or package.get('visibility') != 'public'
                or package.get('repository', {}).get('full_name') != REPOSITORY
                or package.get('owner', {}).get('login') != 'spread-one'):
            raise Deferred('public_linked_package_access_required')
        # Some API representations expose permissions; absence is NOT proof of admin.
        if package.get('permissions', {}).get('admin') is False:
            raise Deferred('package_actions_access_required')
        value = self.json('https://ghcr.io/token?service=ghcr.io&scope=repository%3Aspread-one%2Fmy-mastra%3Apull')
        self.anonymous = value.get('token')
        if not isinstance(self.anonymous, str) or not self.anonymous:
            raise Deferred('registry_auth_missing')

    def head(self):
        value = self.json(MAIN_API).get('object', {}).get('sha', '')
        if not SHA.fullmatch(value):
            raise Deferred('main_invalid')
        return value

    def versions(self):
        rows = []
        for page in range(1, 21):
            batch = self.json(API + '/versions?per_page=100&page=' + str(page))
            if not isinstance(batch, list):
                raise Deferred('inventory_invalid')
            rows.extend(batch)
            if len(batch) < 100:
                return inventory(rows)
        raise Deferred('inventory_cap')

    def content(self, digest, blob=False):
        if not DIGEST.fullmatch(digest):
            raise Deferred('graph_invalid')
        body = self.request(REGISTRY + ('/blobs/' if blob else '/manifests/') + digest)
        if 'sha256:' + hashlib.sha256(body).hexdigest() != digest:
            raise Deferred('registry_read_mismatch')
        try:
            value = json.loads(body)
            if not isinstance(value, dict):
                raise Deferred('graph_invalid')
            return value
        except (ValueError, UnicodeError):
            raise Deferred('parse_failed') from None

    def delete(self, version_id):
        if type(version_id) is not int or version_id <= 0:
            raise Deferred('version_id_invalid')
        self.request(API + '/versions/' + str(version_id), 'DELETE')


class Graph:
    def __init__(self, registry, versions):
        self.registry = registry
        self.nodes = {}
        self.visiting = set()
        for digest in versions:
            self.read(digest)
        if set(self.nodes) - set(versions):
            raise Deferred('graph_version_missing')
        # Cosign v2 stores signatures at sha256-<subject>.sig (legacy .att too).
        # Treat these as FOREIGN roots, not deletion ownership. A retained signature
        # must also protect its subject's recursive graph, even outside the top ten.
        for digest, version in versions.items():
            for tag in version['tags']:
                match = re.fullmatch(r'sha256-([0-9a-f]{64})\.(sig|att)', tag)
                if match:
                    subject = 'sha256:' + match[1]
                    if subject not in self.nodes or subject == digest:
                        raise Deferred('signature_subject_missing_or_invalid')
                    self.nodes[digest]['children'].append(subject)
        # Association edges can introduce cycles independent of OCI descriptors.
        self.depths = {}
        for digest in self.nodes:
            self.check_cycles(digest, set())

    def check_cycles(self, digest, ancestors):
        if digest in ancestors or len(ancestors) > 32:
            raise Deferred('graph_cycle_or_depth')
        if digest not in self.depths:
            depth = max([0, *[1 + self.check_cycles(child, ancestors | {digest})
                              for child in self.nodes[digest]['children']]])
            if depth > 32:
                raise Deferred('graph_cycle_or_depth')
            self.depths[digest] = depth
        return self.depths[digest]

    def read(self, digest, depth=0):
        if digest in self.visiting or depth > 32:
            raise Deferred('graph_cycle_or_depth')
        if digest in self.nodes:
            return
        if len(self.nodes) >= 256:
            raise Deferred('graph_cap')
        if not DIGEST.fullmatch(digest):
            raise Deferred('graph_invalid')
        self.visiting.add(digest)
        value = self.registry.content(digest)
        media = value.get('mediaType')
        children, config = [], None
        if value.get('subject') or value.get('artifactType'):
            raise Deferred('graph_unsupported')
        if value.get('schemaVersion') != 2:
            raise Deferred('graph_unsupported')
        if media in INDEX:
            descriptors = value.get('manifests')
            if not isinstance(descriptors, list) or not descriptors:
                raise Deferred('graph_invalid')
            for descriptor in descriptors:
                child = descriptor.get('digest', '')
                if not DIGEST.fullmatch(child) or descriptor.get('mediaType') not in INDEX | MANIFEST:
                    raise Deferred('graph_unsupported')
                children.append(child)
        elif media in MANIFEST:
            descriptor = value.get('config', {})
            if descriptor.get('mediaType') not in CONFIG or not DIGEST.fullmatch(descriptor.get('digest', '')):
                raise Deferred('graph_unsupported')
            config = self.registry.content(descriptor['digest'], blob=True)
            if not isinstance(value.get('layers'), list):
                raise Deferred('graph_invalid')
            for layer in value['layers']:
                if not isinstance(layer, dict) or not DIGEST.fullmatch(layer.get('digest', '')) or layer.get('urls'):
                    raise Deferred('graph_unsupported')
        else:
            raise Deferred('graph_unsupported')
        self.nodes[digest] = {'children': children, 'config': config, 'manifest': value}
        for child in children:
            self.read(child, depth + 1)
        self.visiting.remove(digest)

    def closure(self, roots):
        result = set()
        pending = list(roots)
        while pending:
            digest = pending.pop()
            if digest not in result:
                result.add(digest)
                pending.extend(self.nodes[digest]['children'])
        return result

    def owned(self, digest, tags):
        if len(tags) != 1 or not re.fullmatch(r'sha-[0-9a-f]{40}', tags[0]):
            return False
        sha = tags[0][4:]
        normal = []
        for child in self.closure([digest]):
            config = self.nodes[child]['config']
            if config is not None:
                if config.get('os') == 'unknown':
                    # Legacy attestation roots are conservative foreign roots: protect their
                    # entire graph rather than claim arbitrary unknown content is app-owned.
                    return False
                normal.append(config)
        if len(normal) != 1:
            return False
        config = normal[0]
        labels = config.get('config', {}).get('Labels') or {}
        return (config.get('os') == 'linux' and config.get('architecture') == 'amd64'
                and labels.get('org.opencontainers.image.source') == SOURCE
                and labels.get('org.opencontainers.image.revision') == sha)

    def plan(self, versions, head, now):
        owned = {digest for digest, value in versions.items() if self.owned(digest, value['tags'])}
        ordered = sorted(owned, key=lambda digest: (versions[digest]['created'], versions[digest]['id']), reverse=True)
        keep = set(ordered[:10]) | {digest for digest in owned if versions[digest]['tags'] == ['sha-' + head]
                                     or versions[digest]['updated'] > now - GRACE_SECONDS}
        all_owned = self.closure(owned)
        foreign = {digest for digest, value in versions.items() if value['tags'] and digest not in owned}
        unknown = {digest for digest in versions if digest not in all_owned and not versions[digest]['tags']}
        protected = self.closure(keep | foreign | unknown)
        candidates = []
        for root in reversed(ordered):
            if root in keep or root in protected:
                continue
            # Root-first: never intentionally leave a tagged old index pointing at deleted children.
            pending, visited = [root], set()
            while pending:
                digest = pending.pop(0)
                if digest in visited:
                    continue
                visited.add(digest)
                pending.extend(self.nodes[digest]['children'])
                if (digest in versions and digest not in protected and digest not in candidates
                        and versions[digest]['updated'] <= now - GRACE_SECONDS):
                    candidates.append(digest)
        # All deletable parents before descendants, including shared children of old roots.
        ordered_candidates, pending = [], set(candidates)
        while pending:
            available = sorted(node for node in pending if not any(node in self.nodes[parent]['children'] for parent in pending))
            if not available:
                raise Deferred('graph_cycle_or_depth')
            ordered_candidates.extend(available)
            pending.difference_update(available)
        return ordered_candidates, protected, len(keep), len(foreign | unknown)


def cleanup(registry, expected_sha, dry_run=False):
    report = {'status': 'deferred', 'reason': 'not_started', 'deleted': 0, 'versions_before': None,
              'versions_remaining': None, 'protected_manifests': 0, 'kept_sha_roots': 0,
              'unknown_or_foreign_roots': 0, 'delete_permission': 'not_exercised', 'plan': [], 'confirmed_deleted_digests': [], 'referenced_deferred': 0, 'attempted_delete_digests': []}
    expected = None
    try:
        if not SHA.fullmatch(expected_sha):
            raise Deferred('main_invalid')
        registry.authorize()
        if registry.head() != expected_sha:
            raise Deferred('main_changed')
        expected = registry.versions()
        report['versions_before'] = report['versions_remaining'] = len(expected)
        graph = Graph(registry, expected)
        candidates, protected, kept, unknown = graph.plan(expected, expected_sha, time.time())
        report.update(protected_manifests=len(protected), kept_sha_roots=kept, unknown_or_foreign_roots=unknown,
                      plan=[{'digest': digest, 'verified_children': sorted(graph.closure([digest]) - {digest})} for digest in candidates])
        if dry_run:
            report.update(status='planned', reason='read_only', eligible_versions=len(candidates))
            return report
        for digest in candidates[:MAX_DELETIONS]:
            if registry.head() != expected_sha:
                raise Deferred('main_changed')
            fresh = registry.versions()
            report['versions_remaining'] = len(fresh)
            if fingerprint(fresh) != fingerprint(expected):
                raise Deferred('publication_or_metadata_race')
            # Re-read the complete remaining graph without cache. Missing/unsupported/hash
            # mismatch stops ALL deletion. Original owned proof is kept only for this run,
            # including children made untagged/orphaned by our own confirmed root deletion.
            fresh_graph = Graph(registry, fresh)
            for node, value in fresh_graph.nodes.items():
                if node not in graph.nodes or value != graph.nodes[node]:
                    raise Deferred('publication_or_graph_race')
            if protected & graph.closure([digest]):
                # Root deletion is safe with shared children, but protected child nodes themselves
                # must never be deleted. REST DELETE addresses one version, not graph pruning.
                if digest in protected:
                    raise Deferred('candidate_protected')
            if any(digest in value['children'] for node, value in fresh_graph.nodes.items() if node != digest):
                report['referenced_deferred'] += 1
                continue
            # The graph read can take time; recheck inventory/main immediately at deletion.
            if registry.head() != expected_sha or fingerprint(registry.versions()) != fingerprint(expected):
                raise Deferred('publication_or_metadata_race')
            report['attempted_delete_digests'].append(digest)
            registry.delete(fresh[digest]['id'])
            actual = registry.versions()
            report['versions_remaining'] = len(actual)
            if digest in actual:
                raise Deferred('delete_not_confirmed')
            report['deleted'] += 1
            report['confirmed_deleted_digests'].append(digest)
            report['delete_permission'] = 'confirmed_by_delete'
            expected = {node: value for node, value in expected.items() if node != digest}
            if fingerprint(actual) != fingerprint(expected):
                raise Deferred('publication_or_delete_race')
        reason = 'referenced_candidate' if report['referenced_deferred'] else ('deletion_budget' if len(candidates) > MAX_DELETIONS else 'policy_satisfied')
        report.update(status='complete' if reason == 'policy_satisfied' else 'deferred', reason=reason)
    except (Deferred, ValueError, TypeError, KeyError, AttributeError, RecursionError) as error:
        report['reason'] = str(error) if isinstance(error, Deferred) else 'parse_or_graph_invalid'
        # A failed query is not a measured remaining count. Report unknown rather than guess.
        if expected is not None:
            try:
                report['versions_remaining'] = len(registry.versions())
            except (Deferred, ValueError, TypeError, KeyError, AttributeError):
                report['versions_remaining'] = None
    return report


def main():
    token, sha = os.environ.get('GITHUB_TOKEN', ''), os.environ.get('GITHUB_SHA', '')
    if not token:
        report = {'status': 'deferred', 'reason': 'package_actions_access_required', 'deleted': 0, 'versions_remaining': None}
    else:
        report = cleanup(Registry(token), sha)
    text = json.dumps(report, sort_keys=True)
    report_path = os.environ.get('RETENTION_REPORT')
    if report_path:
        with open(report_path, 'w') as out:
            out.write(text + '\n')
    print(text)  # Static codes and counts only, never HTTP bodies, tokens, host data or env.
    summary = os.environ.get('GITHUB_STEP_SUMMARY')
    if summary:
        with open(summary, 'a') as out:
            out.write('### App-only GHCR retention result\n```json\n' + text + '\n```\n')
    return 0 if report['status'] == 'complete' else 1


if __name__ == '__main__':
    raise SystemExit(main())
