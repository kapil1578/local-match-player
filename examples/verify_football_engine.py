"""Deterministic synthetic evidence tests; not a real-football accuracy benchmark."""
import json
import unittest

from football_engine import FootballEngine


def player(identifier, x, y=.65, team=0, height=.12, **changes):
    value = {"id": identifier, "point": [x, y],
             "box": [x - .015, y - height, .03, height],
             "confidence": .9, "team": team, "team_confidence": .9,
             "observed_s": 2.0, "motion": None}
    value.update(changes)
    return value


def frame(t, x=.2, tracks=None, **changes):
    value = {"frame_time": t, "shot": 1, "state": "tracking", "camera_valid": True,
             "kits": {"ready": True}, "tracks": tracks if tracks is not None else [player(1, .2), player(2, .6)],
             "ball": {"point": [x, .65], "confidence": .9, "confirmations": 3,
                      "age_s": .05, "observed": True, "status": "detected", "velocity": None}}
    value.update(changes)
    return value


def settle(engine, start=0., x=.2, tracks=None):
    result = None
    for step in range(6):
        result = engine.update(frame(round(start + step * .2, 6), x, tracks))
    return result


class FootballEngineTests(unittest.TestCase):
    def setUp(self):
        self.engine = FootballEngine()

    def test_requires_repeated_ball_and_dwell(self):
        first = self.engine.update(frame(0))
        self.assertEqual(first["possession"]["state"], "unknown")
        candidate = self.engine.update(frame(.2))
        self.assertEqual(candidate["possession"]["state"], "candidate")
        self.assertIsNone(candidate["possession"]["carrier_id"])
        self.engine.update(frame(.4))
        self.engine.update(frame(.6))
        controlled = self.engine.update(frame(.8))
        self.assertEqual(controlled["possession"]["carrier_id"], 1)
        self.assertEqual(controlled["possession"]["kind"], "visible_control_estimate")

    def test_no_retroactive_dwell_credit(self):
        result = settle(self.engine)
        coverage = result["possession"]["coverage"]
        self.assertAlmostEqual(coverage["controlled_s"], .2)
        self.assertLess(coverage["controlled_s"], coverage["observed_s"])
        self.assertEqual(result["possession"]["visible_control_shares"], [{"team": 0, "share": 1.0}])

    def test_ball_unavailable_not_false_loose_or_control(self):
        settle(self.engine)
        result = self.engine.update(frame(1.2, ball=None))
        self.assertEqual(result["possession"]["state"], "unknown")
        self.assertFalse(result["passing"]["available"])
        self.assertEqual(result["events"], [])

    def test_predicted_ball_never_drives_control(self):
        for i in range(10):
            value = frame(i * .2)
            value["ball"].update(status="predicted", observed=False)
            result = self.engine.update(value)
        self.assertEqual(result["possession"]["state"], "unknown")
        self.assertEqual(result["possession"]["coverage"]["controlled_s"], 0)

    def test_old_low_confidence_or_single_confirmation_ball_rejected(self):
        for changes in ({"age_s": .7}, {"confidence": .2}, {"confirmations": 1},
                        {"observed": False}, {"point": [float("nan"), .6]}):
            with self.subTest(changes=changes):
                self.engine.reset()
                value = frame(0)
                value["ball"].update(changes)
                result = self.engine.update(value)
                self.assertEqual(result["possession"]["state"], "unknown")

    def test_contested_and_loose_are_distinct(self):
        tracks = [player(1, .2), player(3, .21, team=1)]
        result = settle(self.engine, tracks=tracks)
        self.assertEqual(result["possession"]["state"], "contested")
        result = self.engine.update(frame(1.2, .4, tracks))
        self.assertEqual(result["possession"]["state"], "loose")

    def test_unknown_kit_near_ball_abstains(self):
        result = settle(self.engine, tracks=[player(1, .2, team=None), player(2, .6)])
        self.assertEqual(result["possession"]["state"], "unknown")
        self.assertIn("carrier_kit_uncertain", result["quality"]["reasons"])

    def test_unready_kit_estimator_does_not_publish_stale_groups(self):
        settle(self.engine)
        result = self.engine.update(frame(1.2, kits={"ready": False}))
        self.assertEqual(result["possession"]["state"], "unknown")
        self.assertEqual(result["strategy"]["groups"], [])
        self.assertFalse(result["passing"]["available"])

    def test_kit_confidence_and_track_age_gates(self):
        for change in ({"team_confidence": .64}, {"observed_s": .2}, {"confidence": .2}):
            with self.subTest(change=change):
                self.engine.reset()
                result = settle(self.engine, tracks=[player(1, .2, **change), player(2, .6)])
                self.assertNotEqual(result["possession"]["state"], "controlled")

    def test_stale_or_unobserved_player_cannot_control(self):
        for change in ({"observed": False}, {"detection_age_s": .7}, {"detection_age_s": None}):
            with self.subTest(change=change):
                self.engine.reset()
                result = settle(self.engine, tracks=[player(1, .2, **change), player(2, .6)])
                self.assertNotEqual(result["possession"]["state"], "controlled")

    def test_validated_flow_between_detections_can_sustain_control(self):
        for i in range(8):
            value = frame(i * .2)
            value["ball"].update(status="tracked", age_s=.6)
            result = self.engine.update(value)
        self.assertEqual(result["possession"]["carrier_id"], 1)

    def test_missing_tracks_break_dwell(self):
        self.engine.update(frame(0))
        self.engine.update(frame(.2))
        self.engine.update(frame(.4, tracks=[]))
        result = self.engine.update(frame(.6))
        self.assertNotEqual(result["possession"]["state"], "controlled")

    def test_ambiguous_duplicate_ids_rejected(self):
        result = settle(self.engine, tracks=[player(1, .2), player(1, .6)])
        self.assertEqual(result["possession"]["state"], "unknown")

    def test_camera_cuts_and_invalid_view_clear_temporal_data(self):
        for changes in ({"shot": 2}, {"camera_valid": False}, {"state": "new_view"},
                        {"state": "wide_view_required"}):
            with self.subTest(changes=changes):
                self.engine.reset()
                settle(self.engine)
                result = self.engine.update(frame(1.2, **changes))
                self.assertEqual(result["possession"]["state"], "unknown")
                self.assertEqual(result["events"], [])

    def test_time_gap_or_regression_resets(self):
        for t in (4., .5, 1.):
            with self.subTest(t=t):
                self.engine.reset()
                settle(self.engine)
                result = self.engine.update(frame(t))
                self.assertEqual(result["possession"]["state"], "unknown")
                self.assertEqual(result["possession"]["coverage"]["controlled_s"], 0)

    def test_invalid_input_is_json_safe_and_resets(self):
        for value in (None, [], {}, frame(float("nan")), frame(float("inf")),
                      frame(True), frame(2, shot=True), frame(2, tracks="bad")):
            with self.subTest(value=value):
                settle(self.engine)
                result = self.engine.update(value)
                json.dumps(result, allow_nan=False)
                self.assertEqual(result["possession"]["state"], "unknown")
                self.engine.reset()

    def test_probable_pass_requires_observed_bridge(self):
        settle(self.engine)
        for t, x in ((1.2, .3), (1.4, .4), (1.6, .5), (1.8, .6),
                     (2., .6), (2.2, .6), (2.4, .6)):
            result = self.engine.update(frame(t, x))
        self.assertEqual(len(result["events"]), 1)
        event = result["events"][0]
        self.assertEqual((event["type"], event["from_id"], event["to_id"]), ("probable_pass", 1, 2))
        self.assertEqual(event["shot"], 1)
        self.assertNotIn("match_minute", event)

    def test_turnover_candidate_requires_opposing_kit_handoff(self):
        tracks = [player(1, .2), player(2, .6, team=1)]
        settle(self.engine, tracks=tracks)
        for t, x in ((1.2, .3), (1.4, .4), (1.6, .5), (1.8, .6),
                     (2., .6), (2.2, .6), (2.4, .6)):
            result = self.engine.update(frame(t, x, tracks))
        self.assertEqual(result["events"][0]["type"], "turnover_candidate")

    def test_ball_disappearance_does_not_manufacture_pass(self):
        settle(self.engine)
        self.engine.update(frame(1.2, ball=None))
        result = settle(self.engine, start=1.4, x=.6)
        self.assertEqual(result["events"], [])

    def test_ball_jump_does_not_manufacture_pass(self):
        settle(self.engine)
        result = settle(self.engine, start=1.2, x=.6)
        self.assertEqual(result["events"], [])

    def test_camera_pan_preserves_control_without_false_event(self):
        for step in range(12):
            shift = step * .015
            tracks = [player(1, .2 + shift), player(2, .6 + shift)]
            value = frame(step * .2, .2 + shift, tracks,
                          camera_transform=[[1., 0., .015 if step else 0.], [0., 1., 0.]])
            result = self.engine.update(value)
        self.assertEqual(result["possession"]["carrier_id"], 1)
        self.assertEqual(result["events"], [])

    def test_observed_pass_is_invariant_to_camera_translation(self):
        settle(self.engine)
        sequence = ((1.2, .3), (1.4, .4), (1.6, .5), (1.8, .6),
                    (2., .6), (2.2, .6), (2.4, .6))
        for step, (timestamp, x) in enumerate(sequence, 1):
            shift = step * .025
            value = frame(timestamp, x + shift,
                          [player(1, .2 + shift), player(2, .6 + shift)],
                          camera_transform=[[1., 0., .025], [0., 1., 0.]])
            result = self.engine.update(value)
        self.assertEqual(len(result["events"]), 1)
        self.assertEqual(result["events"][0]["type"], "probable_pass")

    def test_zoom_or_invalid_affine_breaks_event_bridge(self):
        for matrix in ([[1.1, 0., 0.], [0., 1.1, 0.]], [[float("nan"), 0., 0.], [0., 1., 0.]],
                       None, [[0., 0., 0.], [0., 0., 0.]]):
            with self.subTest(matrix=matrix):
                self.engine.reset()
                settle(self.engine)
                self.engine.update(frame(1.2, .3))
                self.engine.update(frame(1.4, .4, camera_transform=matrix))
                self.engine.update(frame(1.6, .5))
                result = settle(self.engine, start=1.8, x=.6)
                self.assertEqual(result["events"], [])

    def test_id_switch_at_same_ball_not_a_pass(self):
        settle(self.engine)
        result = settle(self.engine, start=1.2, tracks=[player(9, .2), player(2, .6)])
        self.assertEqual(result["events"], [])

    def test_no_probability_and_max_three_ranked_visible_targets(self):
        tracks = [player(i, x) for i, x in enumerate((.2, .4, .55, .7, .8), 1)]
        result = settle(self.engine, tracks=tracks)
        passing = result["passing"]
        self.assertTrue(passing["available"])
        self.assertEqual(len(passing["options"]), 3)
        self.assertIsNone(passing["completion_probability"])
        self.assertEqual(passing["calibration"], "unvalidated")
        self.assertTrue(all(item["completion_probability"] is None for item in passing["options"]))
        self.assertTrue(all(item["progress"] == "unknown" for item in passing["options"]))

    def test_manual_direction_only(self):
        settle(self.engine)
        result = self.engine.update(frame(1.2), direction=1)
        self.assertEqual(result["passing"]["options"][0]["progress"], "forward")
        result = self.engine.update(frame(1.4), direction=-1)
        self.assertEqual(result["passing"]["options"][0]["progress"], "backward")
        result = self.engine.update(frame(1.6), direction="1")
        self.assertEqual(result["passing"]["options"][0]["progress"], "unknown")

    def test_opponent_lane_blockers_and_pressure(self):
        result = settle(self.engine, tracks=[player(1, .2), player(2, .6), player(3, .4, team=1)])
        option = result["passing"]["options"][0]
        self.assertEqual(option["lane"], "blocked")
        self.assertEqual(option["blocker_ids"], [3])
        self.assertTrue(option["reasons"])

    def test_foreshortening_unknown_ranked_after_known(self):
        tracks = [player(1, .2), player(2, .4, height=.03), player(3, .7)]
        result = settle(self.engine, tracks=tracks)
        options = result["passing"]["options"]
        self.assertEqual([item["target_id"] for item in options], [3, 2])
        self.assertEqual(options[1]["lane"], "unknown")

    def test_unknown_player_blocks_claim_of_clear_lane(self):
        result = settle(self.engine, tracks=[player(1, .2), player(2, .6), player(3, .4, team=None)])
        self.assertEqual(result["passing"]["options"][0]["lane"], "unknown")

    def test_motion_sensitive_receiver_lead_and_interception_warning(self):
        tracks = [player(1, .2), player(2, .6, velocity=[.1, 0.]),
                  player(3, .4, .73, team=1, velocity=[0., -.22])]
        result = settle(self.engine, tracks=tracks)
        option = result["passing"]["options"][0]
        self.assertEqual(option["lane"], "pressured")
        self.assertEqual(option["approaching_ids"], [3])
        self.assertAlmostEqual(option["projected_target"][0], .635)
        self.assertEqual(option["projection_horizon_s"], .35)
        self.assertIsNone(option["completion_probability"])

    def test_velocity_validation_and_projection_bound(self):
        for velocity in ([float("nan"), 0.], [20, 0.], "fast"):
            self.engine.reset()
            result = settle(self.engine, tracks=[player(1, .2), player(2, .6, velocity=velocity)])
            self.assertEqual(result["passing"]["options"][0]["projection_horizon_s"], 0.)
        self.engine.reset()
        result = settle(self.engine, tracks=[player(1, .2), player(2, .6, velocity=[1, 1])])
        projected = result["passing"]["options"][0]["projected_target"]
        self.assertLessEqual(((projected[0] - .6)**2 + (projected[1] - .65)**2)**.5, .0801)

    def test_oversize_input_rejected_without_unbounded_math(self):
        for changes in ({"frame_time": 10**1000}, {"shot": 10**1000},
                        {"tracks": [player(i, .2) for i in range(33)]}):
            result = self.engine.update(frame(0, **changes)) if "frame_time" not in changes else self.engine.update(dict(frame(0), **changes))
            self.assertEqual(result["possession"]["state"], "unknown")
            json.dumps(result, allow_nan=False)

    def test_strategy_uses_visible_counts_not_formations(self):
        tracks = [player(1, .2), player(2, .6), player(3, .8, team=1)]
        result = settle(self.engine, tracks=tracks)
        groups = result["strategy"]["groups"]
        self.assertEqual(groups[0]["count"], 2)
        self.assertAlmostEqual(groups[0]["centroid"][0], .4)
        self.assertEqual(groups[0]["coordinate_space"], "normalized_image")
        self.assertNotIn("formation", result["strategy"])

    def test_memory_bounded_and_rolling_window(self):
        for i in range(1800):
            result = self.engine.update(frame(i * .1))
        coverage = result["possession"]["coverage"]
        self.assertLessEqual(coverage["window_s"], 60)
        self.assertLessEqual(coverage["control_coverage"], 1)
        self.assertLessEqual(len(self.engine._intervals), 512)
        self.assertLessEqual(len(self.engine._events), 30)
        self.assertLessEqual(len(self.engine._bridge["points"]) if self.engine._bridge else 0, 64)

    def test_event_history_retains_only_latest_thirty(self):
        settle(self.engine)
        timestamp = 1.
        for index in range(35):
            points = [.3, .4, .5, .6, .6, .6, .6] if index % 2 == 0 else [.5, .4, .3, .2, .2, .2, .2]
            for x in points:
                timestamp = round(timestamp + .2, 4)
                result = self.engine.update(frame(timestamp, x))
        self.assertEqual(len(result["events"]), 30)
        self.assertEqual(result["events"][0]["id"], "1:6")
        self.assertEqual(result["events"][-1]["id"], "1:35")

    def test_partial_coverage_does_not_treat_unknown_as_opponent_control(self):
        settle(self.engine)
        for timestamp in (1.2, 1.4, 1.6, 1.8):
            result = self.engine.update(frame(timestamp, ball=None))
        self.assertEqual(result["possession"]["visible_control_shares"], [{"team": 0, "share": 1.0}])
        self.assertAlmostEqual(result["possession"]["coverage"]["controlled_s"], .2)
        self.assertLess(result["possession"]["coverage"]["control_coverage"], .2)

    def test_reset_and_caller_mutation_do_not_leak_state(self):
        result = settle(self.engine)
        result["possession"]["coverage"]["controlled_s"] = 999
        result = self.engine.update(frame(1.2))
        self.assertLess(result["possession"]["coverage"]["controlled_s"], 1)
        self.engine.reset()
        result = self.engine.update(frame(0))
        self.assertEqual(result["events"], [])
        self.assertEqual(result["possession"]["coverage"]["controlled_s"], 0)


if __name__ == "__main__":
    unittest.main(verbosity=2)
