import copy
import hashlib
import importlib.util
import json
from pathlib import Path
import time
import unittest
from unittest.mock import patch
import urllib.error
import urllib.request

ROOT = Path(__file__).resolve().parent.parent
spec = importlib.util.spec_from_file_location('registry_gc', ROOT / 'deploy/registry_cleanup.py')
gc = importlib.util.module_from_spec(spec)
spec.loader.exec_module(gc)
HEAD = 'f' * 40
NOW = time.time()


class FakeRegistry:
    def __init__(self):
        self.nodes = {}
        self.rows = {}
        self.deleted = []
        self.head_sha = HEAD
        self.denied = None
        self.fail_delete = None
        self.calls = 0
        self.mutation = None
        self.next_id = 1

    def content(self, digest, blob=False):
        if digest not in self.nodes:
            raise gc.Deferred('registry_or_api_read_failed')
        return copy.deepcopy(self.nodes[digest])

    def add_content(self, value):
        digest = 'sha256:' + hashlib.sha256(json.dumps(value, sort_keys=True).encode()).hexdigest()
        self.nodes[digest] = value
        return digest

    def version(self, digest, tags=None, age=2 * 86400):
        self.rows[digest] = {'id': self.next_id, 'tags': tags or [], 'updated': NOW - age, 'created': NOW - age}
        self.next_id += 1
        return digest

    def image(self, sha, tagged=True, age=2 * 86400, source=gc.SOURCE, os='linux'):
        config = self.add_content({'os': os, 'architecture': 'amd64', 'config': {'Labels': {'org.opencontainers.image.source': source, 'org.opencontainers.image.revision': sha}}})
        node = self.add_content({'schemaVersion': 2, 'mediaType': sorted(gc.MANIFEST)[0], 'config': {'mediaType': sorted(gc.CONFIG)[0], 'digest': config}, 'layers': []})
        return self.version(node, ['sha-' + sha] if tagged else [], age)

    def index(self, children, tags, age=2 * 86400):
        node = self.add_content({'schemaVersion': 2, 'mediaType': sorted(gc.INDEX)[0], 'annotations': {'fixture': str(self.next_id)}, 'manifests': [{'mediaType': self.nodes[child]['mediaType'], 'digest': child} for child in children]})
        return self.version(node, tags, age)

    def fill(self):
        return [self.image(format(n, '040x'), age=(30 - n) * 86400) for n in range(1, 13)]

    def authorize(self):
        if self.denied:
            raise gc.Deferred(self.denied)

    def head(self):
        return self.head_sha

    def versions(self):
        self.calls += 1
        if self.mutation:
            self.mutation(self, self.calls)
        return copy.deepcopy(self.rows)

    def delete(self, version_id):
        digest = next(key for key, value in self.rows.items() if value['id'] == version_id)
        if self.fail_delete == digest:
            raise gc.Deferred('delete_rejected_public_limit_or_api')
        self.deleted.append(digest)
        del self.rows[digest]


class GraphGC(unittest.TestCase):
    def setUp(self):
        self.registry = FakeRegistry()

    def run_cleanup(self):
        with patch.object(gc.time, 'time', lambda: NOW):
            return gc.cleanup(self.registry, HEAD)

    def test_cosign_signature_and_attestation_tags_protect_subject_graph(self):
        child = self.registry.image('1' * 40, tagged=False, age=90 * 86400)
        root = self.registry.index([child], ['sha-' + '1' * 40], age=90 * 86400)
        self.registry.fill()
        for extension in ['sig', 'att']:
            signature = self.registry.image(('a' if extension == 'sig' else 'b') * 40, source='foreign', os='unknown')
            self.registry.rows[signature]['tags'] = ['sha256-' + root[7:] + '.' + extension]
        report = self.run_cleanup()
        self.assertEqual(report['status'], 'complete')
        for protected in [root, child, signature]:
            self.assertIn(protected, self.registry.rows)
        self.assertFalse(set(self.registry.deleted) & {root, child, signature})

    def test_signature_missing_subject_and_oci_referrers_defer_all_deletion(self):
        self.registry.fill()
        signature = self.registry.image('a' * 40, source='foreign', os='unknown')
        self.registry.rows[signature]['tags'] = ['sha256-' + '0' * 64 + '.sig']
        self.assertEqual(self.run_cleanup()['reason'], 'signature_subject_missing_or_invalid')
        self.assertEqual(self.registry.deleted, [])
        self.registry.rows[signature]['tags'] = ['foreign-artifact']
        self.registry.nodes[signature]['subject'] = {'digest': next(iter(self.registry.rows))}
        self.assertEqual(self.run_cleanup()['reason'], 'graph_unsupported')
        self.assertEqual(self.registry.deleted, [])

    def test_recent_ten_and_grace_main_are_protected(self):
        roots = self.registry.fill()
        grace = self.registry.image('e' * 40, age=1)
        main = self.registry.image(HEAD, age=40 * 86400)
        report = self.run_cleanup()
        self.assertEqual(report['status'], 'complete')
        self.assertEqual(set(self.registry.deleted), set(roots[:3]))
        self.assertIn(grace, self.registry.rows)
        self.assertIn(main, self.registry.rows)
        self.assertEqual(report['versions_remaining'], 11)
        self.assertEqual(report['confirmed_deleted_digests'], self.registry.deleted)
        self.assertEqual(report['delete_permission'], 'confirmed_by_delete')

    def test_recursive_recent_foreign_unknown_and_shared_children_protected(self):
        child = self.registry.image('1' * 40, tagged=False, age=90 * 86400)
        nested = self.registry.index([child], [], age=90 * 86400)
        old = self.registry.index([nested], ['sha-' + '1' * 40], age=90 * 86400)
        foreign = self.registry.index([child], ['foreign-latest'])
        unknown = self.registry.image('a' * 40, tagged=False, source='foreign')
        recent = self.registry.fill()
        report = self.run_cleanup()
        self.assertEqual(report['status'], 'complete')
        self.assertIn(child, self.registry.rows)
        self.assertIn(foreign, self.registry.rows)
        self.assertIn(unknown, self.registry.rows)
        self.assertNotIn(old, self.registry.rows)
        self.assertNotIn(nested, self.registry.rows)
        self.assertGreaterEqual(report['unknown_or_foreign_roots'], 2)
        self.assertTrue(set(recent[-10:]).issubset(self.registry.rows))

    def test_root_first_order_and_child_failure_preserves_orphan_next_run(self):
        child = self.registry.image('1' * 40, tagged=False, age=90 * 86400)
        old = self.registry.index([child], ['sha-' + '1' * 40], age=90 * 86400)
        self.registry.fill()
        self.registry.fail_delete = child
        report = self.run_cleanup()
        self.assertEqual(report['status'], 'deferred')
        self.assertEqual(report['reason'], 'delete_rejected_public_limit_or_api')
        self.assertIn(old, self.registry.deleted)
        self.assertNotIn(child, self.registry.deleted)
        self.assertIn(child, self.registry.rows)
        self.assertTrue(any(item['digest'] == old and child in item['verified_children'] for item in report['plan']))
        self.registry.fail_delete = None
        report = self.run_cleanup()
        self.assertIn(child, self.registry.rows)  # prior journal never proves new-run orphan ownership
        self.assertGreaterEqual(report['unknown_or_foreign_roots'], 1)

    def test_legacy_attestation_unknown_format_missing_nodes_fail_closed(self):
        child = self.registry.image('1' * 40, tagged=False)
        attestation = self.registry.image('1' * 40, tagged=False, os='unknown')
        root = self.registry.index([child, attestation], ['sha-' + '1' * 40], age=90 * 86400)
        self.registry.fill()
        report = self.run_cleanup()
        self.assertIn(root, self.registry.rows)
        self.assertIn(child, self.registry.rows)
        self.assertIn(attestation, self.registry.rows)
        unknown = self.registry.add_content({'schemaVersion': 2, 'mediaType': 'unsupported/artifact'})
        self.registry.version(unknown)
        self.registry.deleted.clear()
        report = self.run_cleanup()
        self.assertEqual(report['reason'], 'graph_unsupported')
        self.assertEqual(self.registry.deleted, [])
        del self.registry.rows[unknown]
        del self.registry.nodes[child]
        report = self.run_cleanup()
        self.assertEqual(report['reason'], 'registry_or_api_read_failed')
        self.assertEqual(self.registry.deleted, [])

    def test_shared_children_of_two_old_roots_deleted_only_after_both_parents(self):
        child = self.registry.image('1' * 40, tagged=False, age=90 * 86400)
        root_a = self.registry.index([child], ['sha-' + '1' * 40], age=90 * 86400)
        nested = self.registry.index([child], [], age=89 * 86400)
        # Distinct parent representation; each only has one verified amd64 config.
        root_b = self.registry.index([nested], ['sha-' + '1' * 40], age=88 * 86400)
        self.registry.fill()
        report = self.run_cleanup()
        self.assertEqual(report['status'], 'complete', report)
        self.assertLess(self.registry.deleted.index(root_a), self.registry.deleted.index(child))
        self.assertLess(self.registry.deleted.index(root_b), self.registry.deleted.index(child))

    def test_versions_and_graph_mutations_stop_before_delete(self):
        self.registry.fill()
        def mutation(registry, count):
            if count == 2:
                registry.image('e' * 40)
        self.registry.mutation = mutation
        report = self.run_cleanup()
        self.assertEqual(report['reason'], 'publication_or_metadata_race')
        self.assertEqual(self.registry.deleted, [])
        self.registry.mutation = None
        self.registry.calls = 0
        def graph_race(registry, count):
            if count == 2:
                digest = next(iter(registry.rows))
                registry.nodes[digest]['layers'].append({'digest': 'sha256:' + '0' * 64})
        self.registry.mutation = graph_race
        report = self.run_cleanup()
        # Graph comparison/validation changes stop mutation, not only version metadata.
        self.assertIn(report['reason'], ['publication_or_graph_race', 'graph_unsupported'])
        self.assertEqual(self.registry.deleted, [])

    def test_auth_public_delete_restriction_head_cap_failures_do_not_claim_success(self):
        roots = self.registry.fill()
        self.registry.denied = 'package_actions_access_required'
        report = self.run_cleanup()
        self.assertEqual(report['deleted'], 0)
        self.assertIsNone(report['versions_remaining'])
        self.registry.denied = None
        self.registry.fail_delete = roots[0]
        report = self.run_cleanup()
        self.assertEqual(report['reason'], 'delete_rejected_public_limit_or_api')
        self.assertEqual(report['deleted'], 0)
        self.assertEqual(report['delete_permission'], 'not_exercised')
        self.registry.head_sha = 'a' * 40
        self.assertEqual(self.run_cleanup()['reason'], 'main_changed')
        self.registry.head_sha = HEAD
        self.registry.fail_delete = None
        with patch.object(gc, 'MAX_DELETIONS', 1):
            report = self.run_cleanup()
        self.assertEqual(report['deleted'], 1)
        self.assertEqual(report['reason'], 'deletion_budget')

    def test_missing_version_and_predelete_race_and_unconfirmed_delete_stop(self):
        child = self.registry.image('1' * 40, tagged=False, age=90 * 86400)
        self.registry.index([child], ['sha-' + '1' * 40], age=90 * 86400)
        self.registry.fill()
        saved = self.registry.rows.pop(child)
        report = self.run_cleanup()
        self.assertEqual(report['reason'], 'graph_version_missing')
        self.assertEqual(self.registry.deleted, [])
        self.registry.rows[child] = saved
        self.registry.calls = 0
        def predelete_race(registry, count):
            if count == 3:
                registry.image('e' * 40)
        self.registry.mutation = predelete_race
        self.assertEqual(self.run_cleanup()['reason'], 'publication_or_metadata_race')
        self.assertEqual(self.registry.deleted, [])
        self.registry.mutation = None
        with patch.object(self.registry, 'delete', lambda _id: None):
            report = self.run_cleanup()
        self.assertEqual(report['reason'], 'delete_not_confirmed')
        self.assertEqual(report['deleted'], 0)
        self.assertGreater(len(report['attempted_delete_digests']), 0)
        self.assertEqual(report['delete_permission'], 'not_exercised')

    def test_inventory_strict_and_registry_content_hash_and_endpoint_allowlist(self):
        row = {'id': 1, 'name': 'sha256:' + '1' * 64, 'metadata': {'container': {'tags': ['sha-' + HEAD]}}, 'updated_at': '2026-01-01T00:00:00Z', 'created_at': '2026-01-01T00:00:00Z'}
        self.assertEqual(len(gc.inventory([row])), 1)
        for rows in [[row, row], [{**row, 'id': '1'}], [{**row, 'name': 'foreign'}], [{**row, 'updated_at': 'bad'}]]:
            with self.assertRaises(gc.Deferred):
                gc.inventory(rows)
        registry = gc.Registry('synthetic-token')
        with patch.object(registry, 'request', return_value=b'{}'), self.assertRaisesRegex(gc.Deferred, 'registry_read_mismatch'):
            registry.content('sha256:' + '1' * 64)
        with self.assertRaisesRegex(gc.Deferred, 'endpoint_rejected'):
            registry.request('https://api.github.com/users/foreign/packages/container/other/versions', 'DELETE')
        with self.assertRaisesRegex(gc.Deferred, 'version_id_invalid'):
            registry.delete('arbitrary')
        registry.deadline = 0
        with self.assertRaisesRegex(gc.Deferred, 'time_budget'):
            registry.versions()

    def test_credential_free_cdn_redirect_and_independent_workflow_contract(self):
        handler = gc.NoRedirect()
        request = urllib.request.Request(gc.REGISTRY + '/blobs/sha256:' + '1' * 64, headers={'Authorization': 'Bearer synthetic-token'})
        redirect = handler.redirect_request(request, None, 307, '', {}, 'https://pkg-containers.githubusercontent.com/signed?fixture=1')
        self.assertNotIn('Authorization', redirect.headers)
        with self.assertRaises(gc.Deferred):
            handler.redirect_request(request, None, 307, '', {}, 'https://foreign.invalid/steal')
        with self.assertRaises(gc.Deferred):
            handler.redirect_request(urllib.request.Request(gc.API), None, 307, '', {}, 'https://pkg-containers.githubusercontent.com/signed')
        delivery = (ROOT / '.github/workflows/ci.yml').read_text()
        workflow = (ROOT / '.github/workflows/registry-retention.yml').read_text()
        self.assertIn('group: samkim-ghcr-mutation', delivery)
        self.assertIn('group: samkim-ghcr-mutation', workflow)
        self.assertIn('schedule:', workflow)
        self.assertIn("github.ref == 'refs/heads/main'", workflow)
        self.assertNotIn('pull_request', workflow)
        self.assertNotIn('registry_cleanup.py', delivery)
        self.assertNotIn('TS_OAUTH', workflow)
        self.assertIn('if: always()', workflow)
        self.assertIn('actions/upload-artifact', workflow)
        self.assertIn('provenance: false', delivery)


if __name__ == '__main__':
    unittest.main()
