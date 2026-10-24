"""Bounded, shot-local football estimates from observed normalized-image tracks.

This module does not identify people, infer off-camera positions, measure physical
distances, or emit calibrated probabilities. See football-engine-methods.md.
"""
from collections import deque
from copy import deepcopy
import math
import time


VERSION = "football-engine-v1"
MAX_GAP = .8
DWELL = .45
MAX_TRACKS = 32


def _number(value, minimum=0., maximum=1e12):
    return (isinstance(value, (int, float)) and not isinstance(value, bool)
            and minimum <= value <= maximum and math.isfinite(value))


def _point(value):
    return (isinstance(value, (list, tuple)) and len(value) == 2
            and all(_number(item, 0., 1.) for item in value))


def _distance(a, b):
    return math.hypot(a[0] - b[0], a[1] - b[1])


def _near(point, track):
    """Footpoint ellipse; scales with the observed box, never pitch metres."""
    return math.hypot((point[0] - track["point"][0]) / max(.008, track["box"][2] * .9),
                      (point[1] - track["point"][1]) / max(.012, track["box"][3] * .35))


def _eligible(track):
    return (track["team"] in (0, 1) and track["team_confidence"] >= .65
            and track["confidence"] >= .55 and track["observed_s"] >= .6
            and track["observed"] and track["detection_age_s"] <= .6)


def _lead(track, horizon=.35):
    velocity = track.get("velocity")
    if velocity is None:
        return list(track["point"])
    dx, dy = velocity[0] * horizon, velocity[1] * horizon
    length = math.hypot(dx, dy)
    if length > .08:
        dx, dy = dx * .08 / length, dy * .08 / length
    return [min(1., max(0., track["point"][0] + dx)),
            min(1., max(0., track["point"][1] + dy))]


def _segment(point, start, end):
    dx, dy = end[0] - start[0], end[1] - start[1]
    squared = dx * dx + dy * dy
    if squared < 1e-8:
        return 0., _distance(point, start)
    fraction = ((point[0] - start[0]) * dx + (point[1] - start[1]) * dy) / squared
    closest = [start[0] + min(1., max(0., fraction)) * dx,
               start[1] + min(1., max(0., fraction)) * dy]
    return fraction, _distance(point, closest)


def _affine(matrix):
    return (isinstance(matrix, (list, tuple)) and len(matrix) == 2
            and all(isinstance(row, (list, tuple)) and len(row) == 3 for row in matrix)
            and all(_number(value, -4., 4.) for row in matrix for value in row)
            and .1 <= matrix[0][0] * matrix[1][1] - matrix[0][1] * matrix[1][0] <= 4.)


def _transform(point, matrix):
    return [row[0] * point[0] + row[1] * point[1] + row[2] for row in matrix]


def _tracks(raw):
    if not isinstance(raw, list):
        return None
    # Reject overlarge/ambiguous identity sets instead of silently treating a
    # truncated opponent list as evidence of an open passing lane.
    if len(raw) > MAX_TRACKS:
        return None
    values, seen = [], set()
    for item in raw:
        if not isinstance(item, dict):
            return None
        identifier, box = item.get("id"), item.get("box")
        if (not isinstance(identifier, int) or isinstance(identifier, bool)
                or not 0 <= identifier <= 2**53 - 1 or identifier in seen):
            return None
        seen.add(identifier)
        if (not _point(item.get("point")) or not isinstance(box, (tuple, list))
                or len(box) != 4 or not all(_number(x, 0., 1.) for x in box)
                or box[2] < .002 or box[3] < .008
                or not _number(item.get("confidence"), 0., 1.)
                or not _number(item.get("observed_s"))):
            return None
        team = item.get("team")
        if isinstance(team, bool) or team not in (0, 1, None):
            team = None
        team_confidence = item.get("team_confidence", 0.)
        if not _number(team_confidence, 0., 1.):
            team_confidence = 0.
        velocity = item.get("velocity")
        if (not isinstance(velocity, (tuple, list)) or len(velocity) != 2
                or not all(_number(value, -2., 2.) for value in velocity)):
            velocity = None
        detection_age = item.get("detection_age_s", 0.)
        if not _number(detection_age, 0., 60.):
            detection_age = 60.
        values.append({"id": identifier, "point": list(item["point"]), "box": list(box),
                       "confidence": item["confidence"], "observed_s": item["observed_s"],
                       "team": team, "team_confidence": team_confidence,
                       "observed": item.get("observed", True) is True,
                       "detection_age_s": detection_age,
                       "velocity": list(velocity) if velocity is not None else None})
    return values


class FootballEngine:
    """One instance per analysis source; call reset on source/user-session change."""

    def __init__(self):
        self.reset()

    def reset(self):
        self._time = None
        self._shot = None
        self._start = None
        self._candidate = None
        self._candidate_since = None
        self._owner = None
        self._last_ball = None
        self._ball_streak = 0
        self._bridge = None
        self._previous_observed = False
        self._previous_credit = None
        self._intervals = deque(maxlen=512)
        self._events = deque(maxlen=30)
        self._event_sequence = 0

    def _clear_control(self, clear_bridge=True):
        self._candidate = None
        self._candidate_since = None
        self._owner = None
        if clear_bridge:
            self._bridge = None

    def _transform_memory(self, matrix):
        if self._last_ball is not None:
            self._last_ball = _transform(self._last_ball, matrix)
        if not self._bridge:
            return
        a, b = matrix[0][:2]
        c, d = matrix[1][:2]
        # Ground-lane event geometry is unsafe through appreciable zoom/shear.
        # Translation and small affine changes retain a common current frame.
        scale_x, scale_y = math.hypot(a, c), math.hypot(b, d)
        if abs(scale_x - 1.) > .02 or abs(scale_y - 1.) > .02 or abs(a * b + c * d) > .02:
            self._bridge = None
            return
        self._bridge["points"] = deque(((stamp, _transform(point, matrix))
                                         for stamp, point in self._bridge["points"]), maxlen=64)
        previous = self._bridge["owner"]
        previous["point"] = _transform(previous["point"], matrix)
        x, y, width, height = previous["box"]
        corners = [_transform(point, matrix) for point in ((x, y), (x + width, y),
                                                           (x, y + height), (x + width, y + height))]
        xs, ys = [point[0] for point in corners], [point[1] for point in corners]
        previous["box"] = [min(xs), min(ys), max(xs) - min(xs), max(ys) - min(ys)]

    def _result(self, timestamp, shot, began, reasons):
        return {"version": VERSION, "frame_time": timestamp, "shot": shot,
                "scope": "on_camera_estimates",
                "quality": {"ready": False, "reasons": reasons,
                            "coordinate_space": "normalized_image", "calibration": "unvalidated"},
                "ball_evidence": {"usable": False, "consecutive_observations": 0},
                "possession": {"kind": "visible_control_estimate", "state": "unknown",
                               "carrier_id": None, "team": None, "confidence": "low", "dwell_s": 0.,
                               "visible_control_shares": [], "coverage": self._coverage(timestamp)},
                "passing": {"available": False, "completion_probability": None,
                            "calibration": "unvalidated", "direction": 0, "options": []},
                "strategy": {"groups": [], "pressure_near_carrier": None,
                             "support_count": 0, "patterns": []},
                "events": deepcopy(list(self._events)),
                "timing": {"processing_ms": round((time.perf_counter() - began) * 1000, 3)}}

    def _coverage(self, timestamp):
        if timestamp is None or self._start is None:
            return {"window_s": 0., "observed_s": 0., "controlled_s": 0., "control_coverage": 0.}
        lower = max(self._start, timestamp - 60.)
        if self._intervals:
            lower = max(lower, self._intervals[0][0])
        observed, controlled = 0., 0.
        for start, end, valid, team in self._intervals:
            duration = max(0., end - max(start, lower))
            observed += duration if valid else 0.
            controlled += duration if team is not None else 0.
        window = max(0., timestamp - lower)
        return {"window_s": round(window, 3), "observed_s": round(observed, 3),
                "controlled_s": round(controlled, 3),
                "control_coverage": round(min(1., controlled / window), 4) if window else 0.}

    def _shares(self, timestamp):
        totals = {0: 0., 1: 0.}
        for start, end, _, team in self._intervals:
            if team in totals:
                totals[team] += max(0., end - max(start, timestamp - 60.))
        total = sum(totals.values())
        return [{"team": team, "share": round(duration / total, 4)}
                for team, duration in totals.items() if duration > 0.] if total else []

    def _ball(self, raw, timestamp, delta):
        if (not isinstance(raw, dict) or not _point(raw.get("point"))
                or not _number(raw.get("confidence"), .55, 1.)
                or not _number(raw.get("age_s"), 0., .6)
                or not isinstance(raw.get("confirmations"), int)
                or isinstance(raw.get("confirmations"), bool) or raw["confirmations"] < 2
                or raw.get("observed") is not True or raw.get("status") not in ("detected", "tracked")):
            self._ball_streak = 0
            self._last_ball = None
            self._clear_control()
            return None, "fresh_observed_ball_required"
        point = list(raw["point"])
        if self._last_ball is not None and delta and _distance(point, self._last_ball) / delta > 2.5:
            self._ball_streak = 1
            self._last_ball = point
            self._clear_control()
            return None, "ball_discontinuity"
        self._last_ball = point
        self._ball_streak += 1
        if self._ball_streak < 2:
            return None, "repeated_ball_observation_required"
        return point, None

    def _control(self, point, tracks, timestamp):
        if not tracks:
            self._clear_control()
            return "unknown", "visible_players_required"
        ranked = sorted((_near(point, track), track["id"], track) for track in tracks)
        distance, _, nearest = ranked[0]
        # Holding the owner uses a slightly wider ellipse, but never hides a
        # competing player or an uncertain nearest identity/kit.
        current = next((entry for entry in ranked if self._owner and entry[1] == self._owner["id"]), None)
        if current and current[0] <= 1.55 and _eligible(current[2]) and distance > 1.3:
            distance, _, nearest = current
        if distance > (1.55 if current and nearest["id"] == current[1] else 1.3):
            self._clear_control(clear_bridge=False)
            return "loose", None
        if len(ranked) > 1 and ranked[1][0] <= 1.55 and ranked[1][0] - distance <= .65:
            self._clear_control()
            return "contested", "ambiguous_footpoint_proximity"
        if not _eligible(nearest):
            self._clear_control()
            return "unknown", "carrier_kit_uncertain" if nearest["team"] is None or nearest["team_confidence"] < .65 else "stable_player_track_required"
        key = (nearest["id"], nearest["team"])
        if self._candidate != key:
            self._candidate = key
            self._candidate_since = timestamp
            self._owner = None
        if timestamp - self._candidate_since + 1e-9 < DWELL:
            return "candidate", "control_dwell_pending"
        self._owner = nearest
        return "controlled", None

    def _update_bridge(self, point, timestamp, state):
        if self._bridge:
            if timestamp - self._bridge["time"] > 3.:
                self._bridge = None
            else:
                self._bridge["points"].append((timestamp, point))
        if state != "controlled":
            return
        owner = self._owner
        if self._bridge and self._bridge["owner"]["id"] != owner["id"]:
            previous = self._bridge["owner"]
            start, end = previous["point"], owner["point"]
            size_ratio = max(previous["box"][3], owner["box"][3]) / min(previous["box"][3], owner["box"][3])
            interior = []
            consistent_path = True
            corridor = max(.012, min(previous["box"][3], owner["box"][3]) * .4)
            for _, observed in self._bridge["points"]:
                fraction, distance = _segment(observed, start, end)
                if not -.15 <= fraction <= 1.15 or distance > corridor * 2.:
                    consistent_path = False
                if .15 < fraction < .85 and distance <= corridor:
                    interior.append(fraction)
            advancing = all(b >= a - .15 for a, b in zip(interior, interior[1:]))
            if (len(interior) >= 2 and advancing and consistent_path and max(interior) - min(interior) >= .15
                    and _distance(start, end) >= max(.06, previous["box"][2] * 2.) and size_ratio <= 2.5):
                self._event_sequence += 1
                self._events.append({"id": f"{self._shot}:{self._event_sequence}",
                                     "type": "probable_pass" if previous["team"] == owner["team"] else "turnover_candidate",
                                     "from_id": previous["id"], "to_id": owner["id"],
                                     "from_team": previous["team"], "to_team": owner["team"],
                                     "frame_time": timestamp, "shot": self._shot, "confidence": "estimate"})
        self._bridge = {"owner": deepcopy(owner), "time": timestamp,
                        "points": deque([(timestamp, point)], maxlen=64)}

    def _passing(self, tracks, direction):
        result = {"available": bool(self._owner), "completion_probability": None,
                  "calibration": "unvalidated", "direction": direction, "options": []}
        if not self._owner:
            return result
        carrier = self._owner
        targets = [track for track in tracks if track["id"] != carrier["id"]
                   and track["team"] == carrier["team"] and _eligible(track)]
        others = [track for track in tracks if track["team"] != carrier["team"] or not _eligible(track)]
        for target in targets:
            start, end = carrier["point"], target["point"]
            corridor = max(.009, (carrier["box"][2] + target["box"][2]) * .45)
            blockers, uncertain, pressure, moving = [], [], [], []
            lead = _lead(target)
            for other in others:
                fraction, distance = _segment(other["point"], start, end)
                if 0.05 < fraction < .95 and distance <= corridor * 2.:
                    if not _eligible(other):
                        uncertain.append(other["id"])
                    elif distance <= corridor:
                        blockers.append(other["id"])
                    else:
                        pressure.append(other["id"])
                if other.get("velocity") is not None and _eligible(other):
                    projected_fraction, projected_distance = _segment(_lead(other), start, lead)
                    if .05 < projected_fraction < .95 and projected_distance <= corridor:
                        moving.append(other["id"])
            depth_ratio = max(carrier["box"][3], target["box"][3]) / min(carrier["box"][3], target["box"][3])
            reasons = []
            lane = "blocked" if blockers else "pressured" if pressure or moving else "open"
            if depth_ratio > 2.5 or uncertain:
                lane = "unknown"
                if depth_ratio > 2.5:
                    reasons.append("Large apparent-size difference; ground-lane geometry uncertain")
                if uncertain:
                    reasons.append("An uncertain player/kit intersects the apparent lane")
            if blockers:
                reasons.append("Visible opposing footpoints intersect the apparent ground lane")
            elif pressure:
                reasons.append("Visible opponents are near the apparent ground lane")
            elif lane == "open":
                reasons.append("No visible opposing footpoint intersects this image-plane lane")
            if moving:
                reasons.append("Observed opponent motion projects toward the lane within 0.35 seconds")
            if target.get("velocity") is not None:
                reasons.append("Receiver lead uses bounded 0.35-second image-plane motion extrapolation")
            else:
                reasons.append("Receiver motion is not established; current-position comparison only")
            space = min((_distance(target["point"], other["point"]) / target["box"][3]
                         for other in others if _eligible(other)), default=None)
            if space is None:
                reasons.append("No reliable opponent observation for receiver-space comparison")
            elif space < .7:
                if lane == "open":
                    lane = "pressured"
                reasons.append("A visible opponent is close to the receiver")
            progress = "unknown"
            if direction:
                dx = (end[0] - start[0]) * direction
                progress = "forward" if dx > .04 else "backward" if dx < -.04 else "lateral"
            result["options"].append({"target_id": target["id"], "team": target["team"],
                                      "lane": lane, "rank": 0, "reasons": reasons,
                                      "blocker_ids": blockers, "uncertain_ids": uncertain,
                                      "approaching_ids": moving,
                                      "projected_target": [round(value, 4) for value in lead],
                                      "projection_horizon_s": .35 if target.get("velocity") is not None else 0.,
                                      "receiver_space": round(space, 3) if space is not None else None,
                                      "receiver_space_unit": "apparent_player_height",
                                      "progress": progress, "completion_probability": None})
        order = {"open": 0, "pressured": 1, "blocked": 2, "unknown": 3}
        result["options"].sort(key=lambda option: (order[option["lane"]],
                                                 -(option["receiver_space"] or 0), option["target_id"]))
        result["options"] = result["options"][:3]
        for rank, option in enumerate(result["options"], 1):
            option["rank"] = rank
        return result

    def _strategy(self, tracks, passing):
        result = {"groups": [], "pressure_near_carrier": None, "support_count": 0, "patterns": []}
        for team in (0, 1):
            members = [track for track in tracks if track["team"] == team and _eligible(track)]
            if not members:
                continue
            xs, ys = [track["point"][0] for track in members], [track["point"][1] for track in members]
            spread = [max(xs) - min(xs), max(ys) - min(ys)]
            result["groups"].append({"team": team, "count": len(members),
                                     "centroid": [round(sum(xs) / len(xs), 4), round(sum(ys) / len(ys), 4)],
                                     "spread": [round(value, 4) for value in spread],
                                     "coordinate_space": "normalized_image"})
            if len(members) >= 3:
                label = "wide horizontal distribution in view" if spread[0] > .45 else "compact horizontal distribution in view" if spread[0] < .18 else "distributed visible group"
                result["patterns"].append({"team": team, "description": label})
        if self._owner:
            pressure = sum(_near(self._owner["point"], track) < 3. for track in tracks
                           if _eligible(track) and track["team"] != self._owner["team"])
            result["pressure_near_carrier"] = pressure
            result["support_count"] = sum(option["lane"] in ("open", "pressured") for option in passing["options"])
        return result

    def update(self, frame, direction=0):
        began = time.perf_counter()
        if not isinstance(frame, dict):
            self.reset()
            return self._result(None, None, began, ["invalid_frame"])
        timestamp, shot = frame.get("frame_time"), frame.get("shot")
        tracks = _tracks(frame.get("tracks"))
        if (not _number(timestamp) or not isinstance(shot, int) or isinstance(shot, bool)
                or not 0 <= shot <= 2**53 - 1 or tracks is None):
            self.reset()
            return self._result(timestamp if _number(timestamp) else None,
                                shot if _number(shot, 0., 2**53 - 1) else None,
                                began, ["invalid_frame"])
        delta = timestamp - self._time if self._time is not None else 0.
        reason = None
        if self._time is not None and (delta <= 0. or delta > MAX_GAP):
            reason = "frame_time_discontinuity"
        elif self._shot is not None and shot != self._shot:
            reason = "camera_cut"
        elif frame.get("state") != "tracking":
            reason = "stable_wide_view_required"
        elif frame.get("camera_valid") is not True:
            reason = "valid_camera_motion_required"
        elif "camera_transform" in frame and not _affine(frame["camera_transform"]):
            reason = "invalid_camera_transform"
        if reason:
            self.reset()
            self._time, self._shot, self._start = timestamp, shot, timestamp
            return self._result(timestamp, shot, began, [reason])
        if self._start is None:
            self._start = timestamp
        if "camera_transform" in frame:
            self._transform_memory(frame["camera_transform"])
        self._time, self._shot = timestamp, shot
        direction = direction if isinstance(direction, int) and not isinstance(direction, bool) and direction in (-1, 0, 1) else 0
        reasons = []
        point, ball_reason = self._ball(frame.get("ball"), timestamp, delta)
        if ball_reason:
            reasons.append(ball_reason)
        observed = point is not None
        state = "unknown"
        kits = frame.get("kits")
        if not isinstance(kits, dict) or kits.get("ready") is not True:
            self._clear_control()
            reasons.append("stable_kit_groups_required")
        elif observed:
            state, control_reason = self._control(point, tracks, timestamp)
            if control_reason:
                reasons.append(control_reason)
            self._update_bridge(point, timestamp, state)
        credit = (self._owner["id"], self._owner["team"]) if state == "controlled" else None
        if delta > 0.:
            valid_interval = observed and self._previous_observed
            credited_team = credit[1] if valid_interval and credit is not None and credit == self._previous_credit else None
            self._intervals.append((timestamp - delta, timestamp, valid_interval, credited_team))
        while self._intervals and self._intervals[0][1] <= timestamp - 60.:
            self._intervals.popleft()
        self._previous_observed, self._previous_credit = observed, credit
        result = self._result(timestamp, shot, began, reasons)
        result["quality"]["ready"] = observed and bool(tracks) and isinstance(kits, dict) and kits.get("ready") is True
        result["ball_evidence"] = {"usable": observed, "consecutive_observations": self._ball_streak}
        possession = result["possession"]
        possession["state"] = state
        possession["visible_control_shares"] = self._shares(timestamp)
        if state == "controlled":
            possession.update(carrier_id=self._owner["id"], team=self._owner["team"],
                              confidence="high" if self._owner["confidence"] >= .8 and self._owner["team_confidence"] >= .8 else "medium",
                              dwell_s=round(timestamp - self._candidate_since, 3))
        result["passing"] = self._passing(tracks, direction)
        grouped_tracks = tracks if isinstance(kits, dict) and kits.get("ready") is True else []
        result["strategy"] = self._strategy(grouped_tracks, result["passing"])
        result["timing"]["processing_ms"] = round((time.perf_counter() - began) * 1000, 3)
        return result
