--
-- PostgreSQL database dump
--

\restrict w9SepvNeRFdhhp4ERhCUdSvrclr3XVAOq0TtLc1zmgUaPuKVQHugBJO7daPDk4A

-- Dumped from database version 18.3
-- Dumped by pg_dump version 18.3

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET transaction_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Name: pgcrypto; Type: EXTENSION; Schema: -; Owner: -
--

CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA public;


--
-- Name: EXTENSION pgcrypto; Type: COMMENT; Schema: -; Owner: 
--

COMMENT ON EXTENSION pgcrypto IS 'cryptographic functions';


SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: bonds; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.bonds (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    issuer_id uuid NOT NULL,
    buyer_id uuid,
    principal_amount integer NOT NULL,
    interest_rate_percentage integer NOT NULL,
    status character varying(20) DEFAULT 'ISSUED'::character varying NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT bonds_interest_non_negative CHECK ((interest_rate_percentage >= 0)),
    CONSTRAINT bonds_no_self_buy CHECK ((issuer_id <> buyer_id)),
    CONSTRAINT bonds_principal_positive CHECK ((principal_amount > 0)),
    CONSTRAINT bonds_status_valid CHECK (((status)::text = ANY ((ARRAY['ISSUED'::character varying, 'BOUGHT'::character varying, 'REPAID'::character varying, 'DEFAULTED'::character varying])::text[])))
);


ALTER TABLE public.bonds OWNER TO postgres;

--
-- Name: inventories; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.inventories (
    user_id uuid NOT NULL,
    resource_id character varying(50) NOT NULL,
    amount integer DEFAULT 0 NOT NULL,
    quality integer DEFAULT 0 NOT NULL,
    CONSTRAINT inventories_amount_non_negative CHECK ((amount >= 0)),
    CONSTRAINT inventories_quality_non_negative CHECK ((quality >= 0))
);


ALTER TABLE public.inventories OWNER TO postgres;

--
-- Name: market_listings; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.market_listings (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    seller_id uuid NOT NULL,
    resource_id character varying(50) NOT NULL,
    amount integer NOT NULL,
    price_per_unit integer NOT NULL,
    status character varying(20) DEFAULT 'ACTIVE'::character varying NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    quality integer DEFAULT 0 NOT NULL,
    CONSTRAINT market_listings_amount_positive CHECK ((amount > 0)),
    CONSTRAINT market_listings_price_positive CHECK ((price_per_unit > 0)),
    CONSTRAINT market_listings_quality_non_negative CHECK ((quality >= 0)),
    CONSTRAINT market_listings_status_valid CHECK (((status)::text = ANY ((ARRAY['ACTIVE'::character varying, 'SOLD'::character varying, 'CANCELLED'::character varying])::text[])))
);


ALTER TABLE public.market_listings OWNER TO postgres;

--
-- Name: npc_prices; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.npc_prices (
    resource_id character varying(50) NOT NULL,
    current_buy_price integer NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT npc_prices_price_positive CHECK ((current_buy_price > 0))
);


ALTER TABLE public.npc_prices OWNER TO postgres;

--
-- Name: private_contracts; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.private_contracts (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    sender_id uuid NOT NULL,
    receiver_id uuid NOT NULL,
    resource_id character varying(50) NOT NULL,
    amount integer NOT NULL,
    quality integer DEFAULT 0 NOT NULL,
    price_per_unit integer NOT NULL,
    status character varying(20) DEFAULT 'PENDING'::character varying NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT private_contracts_amount_positive CHECK ((amount > 0)),
    CONSTRAINT private_contracts_no_self_trade CHECK ((sender_id <> receiver_id)),
    CONSTRAINT private_contracts_price_positive CHECK ((price_per_unit > 0)),
    CONSTRAINT private_contracts_quality_valid CHECK (((quality >= 0) AND (quality <= 2))),
    CONSTRAINT private_contracts_status_valid CHECK (((status)::text = ANY ((ARRAY['PENDING'::character varying, 'ACCEPTED'::character varying, 'REJECTED'::character varying, 'CANCELLED'::character varying])::text[])))
);


ALTER TABLE public.private_contracts OWNER TO postgres;

--
-- Name: production_jobs; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.production_jobs (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_building_id uuid NOT NULL,
    resource_id character varying(50) NOT NULL,
    start_time timestamp with time zone DEFAULT now() NOT NULL,
    end_time timestamp with time zone NOT NULL,
    yield_amount integer NOT NULL,
    target_quality integer DEFAULT 0 NOT NULL,
    CONSTRAINT production_jobs_quality_non_negative CHECK ((target_quality >= 0)),
    CONSTRAINT production_jobs_yield_amount_check CHECK ((yield_amount > 0))
);


ALTER TABLE public.production_jobs OWNER TO postgres;

--
-- Name: user_buildings; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.user_buildings (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    building_type character varying(50) NOT NULL,
    status character varying(20) DEFAULT 'IDLE'::character varying NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    level integer DEFAULT 1 NOT NULL,
    CONSTRAINT user_buildings_level_positive CHECK ((level >= 1)),
    CONSTRAINT user_buildings_status_check CHECK (((status)::text = ANY ((ARRAY['IDLE'::character varying, 'PRODUCING'::character varying])::text[])))
);


ALTER TABLE public.user_buildings OWNER TO postgres;

--
-- Name: users; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.users (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    username character varying(50) NOT NULL,
    password_hash character varying(255) NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT users_username_min_length CHECK ((char_length((username)::text) >= 3))
);


ALTER TABLE public.users OWNER TO postgres;

--
-- Name: bonds bonds_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.bonds
    ADD CONSTRAINT bonds_pkey PRIMARY KEY (id);


--
-- Name: inventories inventories_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.inventories
    ADD CONSTRAINT inventories_pkey PRIMARY KEY (user_id, resource_id, quality);


--
-- Name: market_listings market_listings_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.market_listings
    ADD CONSTRAINT market_listings_pkey PRIMARY KEY (id);


--
-- Name: npc_prices npc_prices_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.npc_prices
    ADD CONSTRAINT npc_prices_pkey PRIMARY KEY (resource_id);


--
-- Name: private_contracts private_contracts_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.private_contracts
    ADD CONSTRAINT private_contracts_pkey PRIMARY KEY (id);


--
-- Name: production_jobs production_jobs_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.production_jobs
    ADD CONSTRAINT production_jobs_pkey PRIMARY KEY (id);


--
-- Name: production_jobs production_jobs_user_building_id_key; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.production_jobs
    ADD CONSTRAINT production_jobs_user_building_id_key UNIQUE (user_building_id);


--
-- Name: user_buildings user_buildings_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.user_buildings
    ADD CONSTRAINT user_buildings_pkey PRIMARY KEY (id);


--
-- Name: users users_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_pkey PRIMARY KEY (id);


--
-- Name: users users_username_unique; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_username_unique UNIQUE (username);


--
-- Name: idx_bonds_buyer; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_bonds_buyer ON public.bonds USING btree (buyer_id);


--
-- Name: idx_bonds_issuer; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_bonds_issuer ON public.bonds USING btree (issuer_id);


--
-- Name: idx_bonds_status; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_bonds_status ON public.bonds USING btree (status);


--
-- Name: idx_inventories_user_id; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_inventories_user_id ON public.inventories USING btree (user_id);


--
-- Name: idx_market_listings_seller_id; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_market_listings_seller_id ON public.market_listings USING btree (seller_id);


--
-- Name: idx_market_listings_status; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_market_listings_status ON public.market_listings USING btree (status);


--
-- Name: idx_private_contracts_receiver; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_private_contracts_receiver ON public.private_contracts USING btree (receiver_id, status);


--
-- Name: idx_private_contracts_sender; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_private_contracts_sender ON public.private_contracts USING btree (sender_id, status);


--
-- Name: idx_production_jobs_building; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_production_jobs_building ON public.production_jobs USING btree (user_building_id);


--
-- Name: idx_user_buildings_user_id; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_user_buildings_user_id ON public.user_buildings USING btree (user_id);


--
-- Name: bonds bonds_buyer_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.bonds
    ADD CONSTRAINT bonds_buyer_id_fkey FOREIGN KEY (buyer_id) REFERENCES public.users(id);


--
-- Name: bonds bonds_issuer_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.bonds
    ADD CONSTRAINT bonds_issuer_id_fkey FOREIGN KEY (issuer_id) REFERENCES public.users(id);


--
-- Name: inventories inventories_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.inventories
    ADD CONSTRAINT inventories_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: market_listings market_listings_seller_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.market_listings
    ADD CONSTRAINT market_listings_seller_id_fkey FOREIGN KEY (seller_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: private_contracts private_contracts_receiver_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.private_contracts
    ADD CONSTRAINT private_contracts_receiver_id_fkey FOREIGN KEY (receiver_id) REFERENCES public.users(id);


--
-- Name: private_contracts private_contracts_sender_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.private_contracts
    ADD CONSTRAINT private_contracts_sender_id_fkey FOREIGN KEY (sender_id) REFERENCES public.users(id);


--
-- Name: production_jobs production_jobs_user_building_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.production_jobs
    ADD CONSTRAINT production_jobs_user_building_id_fkey FOREIGN KEY (user_building_id) REFERENCES public.user_buildings(id) ON DELETE CASCADE;


--
-- Name: user_buildings user_buildings_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.user_buildings
    ADD CONSTRAINT user_buildings_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- PostgreSQL database dump complete
--

\unrestrict w9SepvNeRFdhhp4ERhCUdSvrclr3XVAOq0TtLc1zmgUaPuKVQHugBJO7daPDk4A

