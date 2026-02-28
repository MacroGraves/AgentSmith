-- Server version: 10.4.28-MariaDB
-- PHP Version: 8.0.28

SET SQL_MODE = "NO_AUTO_VALUE_ON_ZERO";
START TRANSACTION;
SET time_zone = "+00:00";

--
-- Database: `agentsmith`
--

-- --------------------------------------------------------

--
-- Table structure for table `gpt_action_log`
--

CREATE TABLE `gpt_action_log` (
  `id` int(11) NOT NULL COMMENT 'Auto-increment log entry ID',
  `decision_id` varchar(255) NOT NULL COMMENT 'Foreign key to gpt_decisions',
  `action_type` varchar(64) NOT NULL COMMENT 'Type of action: buy, sell, query, wait, complete, etc.',
  `execution_status` varchar(32) DEFAULT 'pending' COMMENT 'pending, executing, completed, failed',
  `execution_result` longtext CHARACTER SET utf8mb4 COLLATE utf8mb4_bin DEFAULT NULL COMMENT 'Result of action execution: orderId, error, data, etc.' CHECK (json_valid(`execution_result`)),
  `execution_time` datetime DEFAULT NULL COMMENT 'When action actually executed',
  `duration_ms` int(11) DEFAULT NULL COMMENT 'How long execution took in milliseconds',
  `created_at` timestamp NOT NULL DEFAULT current_timestamp() COMMENT 'When log entry created'
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='Execution audit trail for all GPT-decided actions';

-- --------------------------------------------------------

--
-- Table structure for table `gpt_auto_loops`
--

CREATE TABLE `gpt_auto_loops` (
  `id` varchar(255) NOT NULL COMMENT 'Unique loop/session UUID',
  `initial_prompt` longtext NOT NULL COMMENT 'The starting prompt that initiated the loop',
  `status` varchar(32) DEFAULT 'running' COMMENT 'running, completed, failed, timeout, paused',
  `decision_count` int(11) DEFAULT 0 COMMENT 'Total decisions made in this loop',
  `start_time` datetime NOT NULL COMMENT 'When loop started',
  `end_time` datetime DEFAULT NULL COMMENT 'When loop ended (NULL if still running)',
  `final_outcome` longtext DEFAULT NULL COMMENT 'Summary of loop results and final action taken',
  `config` longtext CHARACTER SET utf8mb4 COLLATE utf8mb4_bin DEFAULT NULL COMMENT 'Configuration used for this loop: maxIterations, timeoutMs, etc.' CHECK (json_valid(`config`)),
  `created_at` timestamp NOT NULL DEFAULT current_timestamp() COMMENT 'Record creation time',
  `updated_at` timestamp NOT NULL DEFAULT current_timestamp() ON UPDATE current_timestamp() COMMENT 'Last update time'
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='Session tracking for autonomous AutoProcess loops';

-- --------------------------------------------------------

--
-- Table structure for table `gpt_decisions`
--

CREATE TABLE `gpt_decisions` (
  `id` varchar(255) NOT NULL COMMENT 'Unique decision UUID',
  `timestamp` datetime NOT NULL COMMENT 'When decision was made',
  `query` longtext NOT NULL COMMENT 'Original query/prompt that triggered decision',
  `chain` longtext CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL COMMENT 'Array of [think, validate, act, reflect] steps with full reasoning' CHECK (json_valid(`chain`)),
  `actions` longtext CHARACTER SET utf8mb4 COLLATE utf8mb4_bin DEFAULT NULL COMMENT 'Parsed action objects extracted from act step' CHECK (json_valid(`actions`)),
  `market_analysis` longtext CHARACTER SET utf8mb4 COLLATE utf8mb4_bin DEFAULT NULL CHECK (json_valid(`market_analysis`)),
  `status` varchar(32) DEFAULT 'completed' COMMENT 'completed, pending, failed',
  `loop_id` varchar(255) DEFAULT NULL COMMENT 'Link to parent AutoProcess loop if part of autonomous session',
  `next_decision_id` varchar(255) DEFAULT NULL COMMENT 'Link to sequential next decision for chain tracking',
  `result_summary` text DEFAULT NULL COMMENT 'Summary of decision outcomes and action results',
  `created_at` timestamp NOT NULL DEFAULT current_timestamp() COMMENT 'Record creation time',
  `updated_at` timestamp NOT NULL DEFAULT current_timestamp() ON UPDATE current_timestamp() COMMENT 'Last update time'
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='Persistent storage for all GPT decisions with full chain-of-thought';

-- --------------------------------------------------------

--
-- Table structure for table `gpt_market_snapshots`
--

CREATE TABLE `gpt_market_snapshots` (
  `id` int(11) NOT NULL COMMENT 'Auto-increment ID',
  `decision_id` varchar(255) DEFAULT NULL COMMENT 'Associated decision',
  `symbol` varchar(32) DEFAULT NULL COMMENT 'Trading pair: LTCUSDT, BTCUSDT, etc.',
  `price` decimal(18,8) DEFAULT NULL COMMENT 'Asset price at snapshot time',
  `balance` decimal(18,8) DEFAULT NULL COMMENT 'Available balance',
  `market_data` longtext CHARACTER SET utf8mb4 COLLATE utf8mb4_bin DEFAULT NULL COMMENT 'Full market data used for decision' CHECK (json_valid(`market_data`)),
  `snapshot_time` datetime NOT NULL COMMENT 'When snapshot was taken',
  `created_at` timestamp NOT NULL DEFAULT current_timestamp()
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='Market data snapshots captured with each decision for replay/analysis';

-- --------------------------------------------------------

--
-- Table structure for table `trading_cranks`
--

CREATE TABLE `trading_cranks` (
  `coin` varchar(20) NOT NULL COMMENT 'Coin ticker (e.g. LTC, BTC, UNI)',
  `base_amount` decimal(20,4) NOT NULL DEFAULT 0.0000,
  `crank_0` decimal(20,4) NOT NULL DEFAULT 100.0000,
  `crank_1` decimal(20,4) NOT NULL DEFAULT 0.0000,
  `crank_2` decimal(20,4) NOT NULL DEFAULT 0.0000,
  `crank_3` decimal(20,4) NOT NULL DEFAULT 0.0000,
  `locked_usdc` decimal(20,4) NOT NULL DEFAULT 0.0000 COMMENT 'Total USDC permanently locked from this coin',
  `conversions` int(11) NOT NULL DEFAULT 0 COMMENT 'Number of USDC lockup events',
  `created_at` timestamp NOT NULL DEFAULT current_timestamp(),
  `updated_at` timestamp NOT NULL DEFAULT current_timestamp() ON UPDATE current_timestamp()
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- --------------------------------------------------------

--
-- Table structure for table `trading_history`
--

CREATE TABLE `trading_history` (
  `id` varchar(255) NOT NULL COMMENT 'Unique trade ID (UUID)',
  `order_id` varchar(255) DEFAULT NULL COMMENT 'Binance Order ID',
  `pair` varchar(20) NOT NULL COMMENT 'Trading pair (e.g., LTCUSDT)',
  `action` varchar(10) NOT NULL COMMENT 'BUY or SELL',
  `quantity` decimal(20,8) NOT NULL COMMENT 'Amount of asset traded',
  `price` decimal(20,8) NOT NULL COMMENT 'Price per unit',
  `total_value` decimal(20,8) NOT NULL COMMENT 'Total value (quantity * price)',
  `entry_price` decimal(20,8) DEFAULT NULL COMMENT 'Entry price (for sell orders, the entry price of corresponding buy)',
  `profit_loss` decimal(20,8) DEFAULT NULL COMMENT 'Profit/loss amount in USDT',
  `profit_loss_percent` decimal(10,4) DEFAULT NULL COMMENT 'Profit/loss percentage',
  `timestamp` datetime NOT NULL COMMENT 'When trade was executed',
  `loop_id` varchar(255) DEFAULT NULL COMMENT 'Associated autonomous loop ID',
  `decision_id` varchar(255) DEFAULT NULL COMMENT 'Associated GPT decision ID',
  `status` varchar(32) DEFAULT 'completed' COMMENT 'Trade status (pending, completed, failed, cancelled)',
  `notes` text DEFAULT NULL COMMENT 'Additional notes about the trade',
  `created_at` timestamp NOT NULL DEFAULT current_timestamp(),
  `updated_at` timestamp NOT NULL DEFAULT current_timestamp() ON UPDATE current_timestamp()
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- --------------------------------------------------------

--
-- Table structure for table `trading_pairs`
--

CREATE TABLE `trading_pairs` (
  `id` varchar(50) NOT NULL COMMENT 'Trading pair (e.g., LTCUSDT)',
  `base_asset` varchar(20) NOT NULL COMMENT 'Base asset (e.g., LTC)',
  `quote_asset` varchar(20) NOT NULL COMMENT 'Quote asset (e.g., USDT)',
  `last_checked` datetime DEFAULT NULL COMMENT 'Last analysis timestamp',
  `last_action` varchar(50) DEFAULT NULL COMMENT 'Last action taken (BUY/SELL/WAIT)',
  `volatility` decimal(10,4) DEFAULT NULL COMMENT '24h price volatility percentage',
  `volume_24h` decimal(20,2) DEFAULT NULL COMMENT '24h trading volume in quote asset',
  `price_change_24h` decimal(10,4) DEFAULT NULL COMMENT '24h price change percentage',
  `trend` varchar(20) DEFAULT NULL COMMENT 'Current trend (UPTREND/DOWNTREND/NEUTRAL)',
  `score` decimal(10,4) DEFAULT NULL COMMENT 'Pair viability score (0-100)',
  `enabled` tinyint(1) DEFAULT 1 COMMENT 'Whether to include in trading rotation',
  `notes` text DEFAULT NULL COMMENT 'Analysis notes',
  `created_at` timestamp NOT NULL DEFAULT current_timestamp(),
  `updated_at` timestamp NOT NULL DEFAULT current_timestamp() ON UPDATE current_timestamp()
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- --------------------------------------------------------

--
-- Table structure for table `transactions`
--

CREATE TABLE `transactions` (
  `id` int(11) NOT NULL,
  `uuid` varchar(64) NOT NULL,
  `address` varchar(128) NOT NULL,
  `balance` varchar(172) NOT NULL,
  `tx` varchar(172) NOT NULL,
  `transaction_type` varchar(32) NOT NULL,
  `status` varchar(32) NOT NULL DEFAULT 'Pending',
  `currency` varchar(32) NOT NULL,
  `created` datetime DEFAULT current_timestamp()
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- --------------------------------------------------------

--
-- Stand-in structure for view `vw_action_summary`
-- (See below for the actual view)
--
CREATE TABLE `vw_action_summary` (
`loop_id` varchar(255)
,`action_type` varchar(64)
,`count` bigint(21)
,`completed` decimal(22,0)
,`failed` decimal(22,0)
,`avg_duration_ms` decimal(14,4)
);

-- --------------------------------------------------------

--
-- Stand-in structure for view `vw_decision_chain`
-- (See below for the actual view)
--
CREATE TABLE `vw_decision_chain` (
`loop_id` varchar(255)
,`decision_id` varchar(255)
,`timestamp` datetime
,`query_preview` varchar(100)
,`chain_steps` int(10)
,`action_count` int(10)
,`primary_action` longtext
,`result_summary` text
);

-- --------------------------------------------------------

--
-- Stand-in structure for view `vw_loop_summary`
-- (See below for the actual view)
--
CREATE TABLE `vw_loop_summary` (
`loop_id` varchar(255)
,`initial_prompt` longtext
,`status` varchar(32)
,`decision_count` int(11)
,`start_time` datetime
,`end_time` datetime
,`duration_seconds` bigint(21)
,`actual_decisions` bigint(21)
,`final_outcome` longtext
);

-- --------------------------------------------------------

--
-- Table structure for table `wallets`
--

CREATE TABLE `wallets` (
  `uuid` varchar(128) NOT NULL,
  `user_uuid` varchar(64) NOT NULL,
  `name` varchar(64) NOT NULL,
  `address` varchar(128) DEFAULT NULL,
  `withdrawalAddress` varchar(128) DEFAULT NULL,
  `balance` varchar(128) NOT NULL DEFAULT '0',
  `withdrawBalance` varchar(128) NOT NULL DEFAULT '0',
  `intent` int(11) NOT NULL DEFAULT 0,
  `fee` varchar(128) NOT NULL DEFAULT '0',
  `tx` int(11) NOT NULL DEFAULT 0
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

-- --------------------------------------------------------

--
-- Structure for view `vw_action_summary`
--
DROP TABLE IF EXISTS `vw_action_summary`;

CREATE ALGORITHM=UNDEFINED DEFINER=`root`@`localhost` SQL SECURITY DEFINER VIEW `vw_action_summary`  AS SELECT `d`.`loop_id` AS `loop_id`, `pal`.`action_type` AS `action_type`, count(0) AS `count`, sum(case when `pal`.`execution_status` = 'completed' then 1 else 0 end) AS `completed`, sum(case when `pal`.`execution_status` = 'failed' then 1 else 0 end) AS `failed`, avg(`pal`.`duration_ms`) AS `avg_duration_ms` FROM (`gpt_action_log` `pal` join `gpt_decisions` `d` on(`pal`.`decision_id` = `d`.`id`)) GROUP BY `d`.`loop_id`, `pal`.`action_type` ORDER BY `d`.`loop_id` ASC, `pal`.`action_type` ASC ;

-- --------------------------------------------------------

--
-- Structure for view `vw_decision_chain`
--
DROP TABLE IF EXISTS `vw_decision_chain`;

CREATE ALGORITHM=UNDEFINED DEFINER=`root`@`localhost` SQL SECURITY DEFINER VIEW `vw_decision_chain`  AS SELECT `d`.`loop_id` AS `loop_id`, `d`.`id` AS `decision_id`, `d`.`timestamp` AS `timestamp`, substr(`d`.`query`,1,100) AS `query_preview`, json_length(`d`.`chain`) AS `chain_steps`, if(`d`.`actions` is not null,json_length(`d`.`actions`),0) AS `action_count`, if(json_extract(`d`.`chain`,'$[2].actions') is not null,json_extract(`d`.`chain`,'$[2].actions[0].action'),NULL) AS `primary_action`, `d`.`result_summary` AS `result_summary` FROM `gpt_decisions` AS `d` ORDER BY `d`.`loop_id` ASC, `d`.`timestamp` ASC ;

-- --------------------------------------------------------

--
-- Structure for view `vw_loop_summary`
--
DROP TABLE IF EXISTS `vw_loop_summary`;

CREATE ALGORITHM=UNDEFINED DEFINER=`root`@`localhost` SQL SECURITY DEFINER VIEW `vw_loop_summary`  AS SELECT `al`.`id` AS `loop_id`, `al`.`initial_prompt` AS `initial_prompt`, `al`.`status` AS `status`, `al`.`decision_count` AS `decision_count`, `al`.`start_time` AS `start_time`, `al`.`end_time` AS `end_time`, timestampdiff(SECOND,`al`.`start_time`,coalesce(`al`.`end_time`,current_timestamp())) AS `duration_seconds`, count(`gd`.`id`) AS `actual_decisions`, `al`.`final_outcome` AS `final_outcome` FROM (`gpt_auto_loops` `al` left join `gpt_decisions` `gd` on(`al`.`id` = `gd`.`loop_id`)) GROUP BY `al`.`id` ORDER BY `al`.`start_time` DESC ;

--
-- Indexes for dumped tables
--

--
-- Indexes for table `gpt_action_log`
--
ALTER TABLE `gpt_action_log`
  ADD PRIMARY KEY (`id`),
  ADD KEY `idx_decision_id` (`decision_id`) COMMENT 'Find actions for a decision',
  ADD KEY `idx_action_type` (`action_type`) COMMENT 'Query by action type',
  ADD KEY `idx_status` (`execution_status`) COMMENT 'Find pending/failed actions',
  ADD KEY `idx_execution_time` (`execution_time`) COMMENT 'Recent execution queries',
  ADD KEY `idx_created` (`created_at`) COMMENT 'Audit trail ordering';

--
-- Indexes for table `gpt_auto_loops`
--
ALTER TABLE `gpt_auto_loops`
  ADD PRIMARY KEY (`id`),
  ADD KEY `idx_status` (`status`) COMMENT 'Find active/completed loops',
  ADD KEY `idx_start_time` (`start_time`) COMMENT 'Historical loop queries',
  ADD KEY `idx_end_time` (`end_time`) COMMENT 'Find recently completed loops',
  ADD KEY `idx_created` (`created_at`) COMMENT 'Time-based loop analysis';

--
-- Indexes for table `gpt_decisions`
--
ALTER TABLE `gpt_decisions`
  ADD PRIMARY KEY (`id`),
  ADD KEY `idx_timestamp` (`timestamp`) COMMENT 'Query decisions by time',
  ADD KEY `idx_status` (`status`) COMMENT 'Filter by completion status',
  ADD KEY `idx_loop_id` (`loop_id`) COMMENT 'Retrieve all decisions from a loop',
  ADD KEY `idx_created` (`created_at`) COMMENT 'Recent decision tracking',
  ADD KEY `fk_next_decision` (`next_decision_id`);

--
-- Indexes for table `gpt_market_snapshots`
--
ALTER TABLE `gpt_market_snapshots`
  ADD PRIMARY KEY (`id`),
  ADD KEY `idx_decision_id` (`decision_id`),
  ADD KEY `idx_symbol` (`symbol`),
  ADD KEY `idx_snapshot_time` (`snapshot_time`);

--
-- Indexes for table `trading_cranks`
--
ALTER TABLE `trading_cranks`
  ADD PRIMARY KEY (`coin`);

--
-- Indexes for table `trading_history`
--
ALTER TABLE `trading_history`
  ADD PRIMARY KEY (`id`),
  ADD UNIQUE KEY `order_id` (`order_id`),
  ADD KEY `idx_timestamp` (`timestamp`),
  ADD KEY `idx_action` (`action`),
  ADD KEY `idx_pair` (`pair`),
  ADD KEY `idx_loop_id` (`loop_id`),
  ADD KEY `idx_status` (`status`);

--
-- Indexes for table `trading_pairs`
--
ALTER TABLE `trading_pairs`
  ADD PRIMARY KEY (`id`),
  ADD KEY `idx_last_checked` (`last_checked`),
  ADD KEY `idx_enabled` (`enabled`),
  ADD KEY `idx_score` (`score`);

--
-- Indexes for table `transactions`
--
ALTER TABLE `transactions`
  ADD PRIMARY KEY (`id`),
  ADD UNIQUE KEY `tx` (`tx`),
  ADD KEY `tx_index` (`tx`),
  ADD KEY `uuid_index` (`uuid`),
  ADD KEY `address_index` (`address`);

--
-- Indexes for table `wallets`
--
ALTER TABLE `wallets`
  ADD PRIMARY KEY (`uuid`),
  ADD KEY `user_uuid_index` (`user_uuid`),
  ADD KEY `address_index` (`address`);

--
-- AUTO_INCREMENT for dumped tables
--

--
-- AUTO_INCREMENT for table `gpt_action_log`
--
ALTER TABLE `gpt_action_log`
  MODIFY `id` int(11) NOT NULL AUTO_INCREMENT COMMENT 'Auto-increment log entry ID';

--
-- AUTO_INCREMENT for table `gpt_market_snapshots`
--
ALTER TABLE `gpt_market_snapshots`
  MODIFY `id` int(11) NOT NULL AUTO_INCREMENT COMMENT 'Auto-increment ID';

--
-- AUTO_INCREMENT for table `transactions`
--
ALTER TABLE `transactions`
  MODIFY `id` int(11) NOT NULL AUTO_INCREMENT;

--
-- Constraints for dumped tables
--

--
-- Constraints for table `gpt_action_log`
--
ALTER TABLE `gpt_action_log`
  ADD CONSTRAINT `gpt_action_log_ibfk_1` FOREIGN KEY (`decision_id`) REFERENCES `gpt_decisions` (`id`) ON DELETE CASCADE;

--
-- Constraints for table `gpt_decisions`
--
ALTER TABLE `gpt_decisions`
  ADD CONSTRAINT `fk_next_decision` FOREIGN KEY (`next_decision_id`) REFERENCES `gpt_decisions` (`id`) ON DELETE SET NULL;

--
-- Constraints for table `gpt_market_snapshots`
--
ALTER TABLE `gpt_market_snapshots`
  ADD CONSTRAINT `gpt_market_snapshots_ibfk_1` FOREIGN KEY (`decision_id`) REFERENCES `gpt_decisions` (`id`) ON DELETE CASCADE;
COMMIT;
