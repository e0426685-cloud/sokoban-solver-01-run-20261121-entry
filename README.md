# Sokoban Solver — push-optimal, room by room

![Rank](https://make.fun/badge/sokoban-solver-01-run-20261121/e0426685-cloud/sokoban-solver-01-run-20261121-entry/rank.svg)
![Reward](https://make.fun/badge/sokoban-solver-01-run-20261121/e0426685-cloud/sokoban-solver-01-run-20261121-entry/reward.svg)

Push-optimal Sokoban solver for make.fun's
[Build the best Sokoban solver, 21 November 2026](https://make.fun/bounty/sokoban-solver-01-run-20261121)
bounty ($100, 10 places). A level is a hallway with rooms off it and a box
pushed out of its room never comes back, so each room is solved alone with a
push-based A* (cheapest box-to-goal assignment by Manhattan distance as the
heuristic, plus dead-cell pruning) and the rooms are stitched together with
hallway walks. Run with `node main.ts`; it reads `/input/<id>/level.txt`
and writes `/output/<id>/solution.txt`. Practice set: 1,000,000/1,000,000
(all five instances in exactly the push-optimal count). Referral: `52532a96`.
